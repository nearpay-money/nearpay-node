/**
 * `nearpay.events.stream()` — the live event stream `GET /v1/events/stream` as an async iterator
 * (spec 0.3.0 `streamEvents`, lld/webhooks.md §5.1, lld/sdks-and-tools.md §1).
 *
 * ```ts
 * const stream = nearpay.events.stream({ types: ["invoice.paid", "customer.subscription.deleted"] });
 * for await (const event of stream) {
 *   if (event.type === "invoice.paid") fulfil(event.data.object.id);
 * }
 * ```
 *
 * - Frames: `ready` (`EventStreamReady`, `onReady`), `event` (an `Event`, yielded as a `TypedEvent`,
 *   parsed tolerantly like every response), `reset` (`EventStreamReset`, `onReset`; the server could not
 *   honour the resume cursor and continues live — catch up with `events.list` if you need the gap).
 * - Resume: every reconnect sends `Last-Event-ID: <last event yielded>`, so nothing is skipped across
 *   the server's 1 h close, a dropped connection, a slow-reader close or a 429/5xx; `starting_after`
 *   resumes the first connection. Delivery is at-least-once in id order: the iterator drops ids it has
 *   already yielded (the last 10 000).
 * - Reconnect: after a clean close, after the server's `retry:` delay (3 s); after errors, with
 *   exponential backoff 1 s → 30 s (jitter; `Retry-After` honoured). A silent connection (no data and
 *   no heartbeat for `idleTimeoutMs`, default 45 s) is treated as dropped. Errors a retry cannot fix
 *   (`401`, `403` — e.g. `livemode_forbidden`: API keys stream **test mode only** — `400
 *   event_type_unknown`) end the iteration by throwing.
 * - Streamed events are not webhook deliveries: they are not signed. Use webhooks (and
 *   `webhooks.constructEvent`) for production fulfilment; the stream is for development tools,
 *   dashboards and tests.
 */
import {
  EVENT_STREAM_HEARTBEAT_S,
  EVENT_STREAM_RETRY_MS,
  Event,
  EventStreamReady,
  EventStreamReset,
  safeParseTolerant,
  type TypedEvent,
  type WebhookType,
} from "@nearpay/spec";
import type { z } from "zod";
import { NearPayConnectionError, NearPayError, NearPayResponseValidationError } from "../http/errors.js";
import { describeIssues, parseTolerantBody, type ResponseValidation, type ValidationIssue } from "../http/parse.js";
import { backoffMs, parseRetryAfter, type Transport } from "../http/transport.js";

/** First frame of every connection (`event: ready`). */
export type EventStreamReadyFrame = z.output<typeof EventStreamReady>;
/** The server could not resume from the cursor and continues live only (`event: reset`). */
export type EventStreamResetFrame = z.output<typeof EventStreamReset>;

export interface EventStreamParams {
  /**
   * Event types to receive: webhook types (`"invoice.paid"`), or `"*"` (default, every type). An
   * array is sent comma-separated; a type the API does not know answers `400 event_type_unknown`.
   */
  readonly types?: readonly (WebhookType | "*" | (string & {}))[] | string;
  /** Replay every event after this one (last 30 days) before going live; first connection only. */
  readonly starting_after?: string;
}

/** Why the stream is reconnecting (`onReconnect`). */
export interface EventStreamReconnect {
  /** Consecutive failed connections (0 after a clean server close). */
  readonly attempt: number;
  readonly delayMs: number;
  /** The error that ended the previous connection; undefined after a clean close. */
  readonly error: NearPayError | undefined;
  /** The cursor the next connection resumes after (`Last-Event-ID`). */
  readonly lastEventId: string | undefined;
}

export interface EventStreamOptions {
  /** Ends the stream (like `close()`). */
  readonly signal?: AbortSignal;
  /** Reconnect after a close or a retryable error (default `true`); `false` ends the iteration instead. */
  readonly reconnect?: boolean;
  /** Backoff after errors: first delay and cap in ms (defaults 1 000 / 30 000). */
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  /** A connection with no bytes (not even a heartbeat) for this long is dropped and reopened; default 45 000. */
  readonly idleTimeoutMs?: number;
  /** Called with the `ready` frame of every connection. */
  readonly onReady?: (ready: EventStreamReadyFrame) => void;
  /** Called on a `reset` frame; default: one process warning. */
  readonly onReset?: (reset: EventStreamResetFrame) => void;
  /** Called before each reconnect. */
  readonly onReconnect?: (info: EventStreamReconnect) => void;
  /** Override the pinned `NearPay-Version`. */
  readonly apiVersion?: string;
  /** How frames are checked against the spec; default the client's `responseValidation`. */
  readonly validation?: ResponseValidation;
  /** Frames that do not match the spec (tolerant mode); default: one process warning. */
  readonly onValidationIssue?: (issues: readonly ValidationIssue[], frame: string) => void;
}

/** An open event stream: iterate it once (`for await`), or `close()` it. */
export interface EventStream extends AsyncIterable<TypedEvent> {
  /** Id of the last event yielded (the resume cursor). */
  readonly lastEventId: string | undefined;
  /** The latest `ready` frame. */
  readonly ready: EventStreamReadyFrame | undefined;
  /** Connections opened so far. */
  readonly connections: number;
  readonly closed: boolean;
  /** Stops the stream; a pending `next()` resolves `done`. */
  close(): void;
}

/** One parsed server-sent event (WHATWG HTML §9.2 event stream format). */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly id: string | undefined;
  readonly retry: number | undefined;
}

/**
 * Incremental SSE parser: feed decoded text chunks, get complete frames. Lines end with CRLF, LF or
 * CR; `:` lines are comments (heartbeats); `data:` lines join with `\n`; a blank line dispatches.
 */
export class SseParser {
  #buf = "";
  #event = "";
  #data: string[] = [];
  #id: string | undefined;
  #retry: number | undefined;
  #pendingCr = false;

  push(chunk: string): SseFrame[] {
    let text = chunk;
    if (this.#pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.#pendingCr = false;
    this.#buf += text;
    const frames: SseFrame[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.#buf);
      if (!m) break;
      // a trailing lone CR may be the first half of CRLF: wait for the next chunk
      if (m[0] === "\r" && m.index === this.#buf.length - 1) {
        this.#pendingCr = true;
      }
      const line = this.#buf.slice(0, m.index);
      this.#buf = this.#buf.slice(m.index + m[0].length);
      const frame = this.#line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  #line(line: string): SseFrame | undefined {
    if (line === "") {
      const frame =
        this.#data.length > 0
          ? { event: this.#event || "message", data: this.#data.join("\n"), id: this.#id, retry: this.#retry }
          : this.#retry !== undefined
            ? { event: "", data: "", id: this.#id, retry: this.#retry }
            : undefined;
      this.#event = "";
      this.#data = [];
      this.#id = undefined;
      this.#retry = undefined;
      return frame;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#event = value;
    else if (field === "data") this.#data.push(value);
    else if (field === "id" && !value.includes("\0")) this.#id = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.#retry = Number(value);
    return undefined;
  }
}

const SEEN_MAX = 10_000;
const FATAL_STATUSES = new Set([400, 401, 403, 404]);

/** Whether reconnecting can help after this error. */
export function isRetryableStreamError(e: unknown): boolean {
  if (e instanceof NearPayConnectionError) return true;
  if (!(e instanceof NearPayError)) return false;
  if (e.statusCode !== undefined && FATAL_STATUSES.has(e.statusCode)) return false;
  return e.retryable || e.statusCode === undefined;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

interface Defaults {
  readonly validation: ResponseValidation;
}

/** Opens `GET /v1/events/stream` with resume and reconnection (see the module comment). */
export function openEventStream(
  transport: Transport,
  route: Parameters<Transport["connect"]>[0],
  params: EventStreamParams = {},
  options: EventStreamOptions = {},
  defaults: Defaults = { validation: transport.options.responseValidation ?? "tolerant" },
): EventStream {
  const stop = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) stop.abort();
    else options.signal.addEventListener("abort", () => stop.abort(), { once: true });
  }
  const reconnect = options.reconnect ?? true;
  const baseMs = options.reconnectBaseMs ?? 1_000;
  const maxMs = options.reconnectMaxMs ?? 30_000;
  const idleMs = options.idleTimeoutMs ?? EVENT_STREAM_HEARTBEAT_S * 3_000;
  const mode = options.validation ?? defaults.validation;
  const types = Array.isArray(params.types) ? params.types.join(",") : (params.types as string | undefined);
  const seen = new Set<string>();
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    process.emitWarning(message, { type: "NearPayWarning", code: "NEARPAY_EVENT_STREAM" });
  };

  const state = {
    lastEventId: params.starting_after as string | undefined,
    yielded: false,
    ready: undefined as EventStreamReadyFrame | undefined,
    connections: 0,
    retryMs: EVENT_STREAM_RETRY_MS,
    started: false,
  };

  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > SEEN_MAX) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
  };

  const report = (issues: readonly ValidationIssue[], frame: string) => {
    if (options.onValidationIssue) options.onValidationIssue(issues, frame);
    else
      warnOnce(
        `shape:${frame}`,
        `NearPay event stream frame "${frame}" does not match @nearpay/spec (passed on as received): ${describeIssues(issues)}`,
      );
  };

  /** Parses a frame payload with a schema per the validation mode; undefined = drop the frame. */
  const parseFrame = <T>(schema: z.ZodType, data: string, frame: string): T | undefined => {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      const issues = [{ path: [], message: "data is not JSON", code: "invalid_json" }];
      if (mode === "strict") {
        throw new NearPayResponseValidationError({ message: `event stream frame "${frame}" is not JSON`, issues });
      }
      if (mode === "tolerant") report(issues, frame);
      return undefined;
    }
    if (mode === "off") return json as T;
    const outcome =
      frame === "event"
        ? parseTolerantBody(schema, json)
        : (() => {
            const r = safeParseTolerant(schema, json);
            return r.success
              ? ({ ok: true, data: r.data } as const)
              : ({
                  ok: false,
                  issues: r.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
                } as const);
          })();
    if (outcome.ok) return outcome.data as T;
    if (mode === "strict") {
      throw new NearPayResponseValidationError({
        message: `event stream frame "${frame}" does not match @nearpay/spec: ${describeIssues(outcome.issues)}`,
        raw: json,
        issues: outcome.issues,
      });
    }
    report(outcome.issues, frame);
    return json as T;
  };

  async function* run(): AsyncGenerator<TypedEvent, void, undefined> {
    let failures = 0;
    try {
      while (!stop.signal.aborted) {
        const conn = new AbortController();
        const onStop = () => conn.abort();
        stop.signal.addEventListener("abort", onStop, { once: true });
        let idle: ReturnType<typeof setTimeout> | undefined;
        const touch = () => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => conn.abort(new Error("idle")), idleMs);
        };
        let error: NearPayError | undefined;
        let gotReady = false;
        try {
          const resume = state.lastEventId;
          // the header wins over `starting_after`; the first connection may use either
          const query: Record<string, unknown> = {};
          if (types !== undefined) query.types = types;
          const headers: Record<string, string> = {};
          if (resume !== undefined) headers["Last-Event-ID"] = resume;
          state.connections++;
          const res = await transport.connect(
            route,
            { query: Object.keys(query).length ? query : undefined },
            { signal: conn.signal, headers, apiVersion: options.apiVersion },
          );
          const body = res.body;
          if (!body) throw new NearPayConnectionError({ message: "event stream response has no body" });
          const reader = body.pipeThrough(new TextDecoderStream()).getReader();
          const parser = new SseParser();
          touch();
          try {
            for (;;) {
              let chunk: ReadableStreamReadResult<string>;
              try {
                chunk = await reader.read();
              } catch (e) {
                if (stop.signal.aborted) return;
                const idleAbort = conn.signal.aborted;
                throw new NearPayConnectionError({
                  message: idleAbort
                    ? `event stream was silent for ${idleMs} ms (no heartbeat); reconnecting`
                    : `event stream connection dropped: ${(e as Error).message}`,
                  timedOut: idleAbort,
                  cause: e,
                });
              }
              if (chunk.done) break;
              touch();
              for (const frame of parser.push(chunk.value)) {
                if (frame.retry !== undefined) state.retryMs = frame.retry;
                if (frame.event === "ready") {
                  const ready = parseFrame<EventStreamReadyFrame>(EventStreamReady, frame.data, "ready");
                  if (ready) {
                    state.ready = ready;
                    gotReady = true;
                    failures = 0;
                    options.onReady?.(ready);
                  }
                } else if (frame.event === "reset") {
                  const reset = parseFrame<EventStreamResetFrame>(EventStreamReset, frame.data, "reset");
                  if (reset) {
                    // the cursor cannot be honoured: do not send it again on the next reconnect
                    if (state.lastEventId === reset.cursor) state.lastEventId = undefined;
                    if (options.onReset) options.onReset(reset);
                    else
                      warnOnce(
                        "reset",
                        `NearPay event stream could not resume after ${reset.cursor} (${String(reset.reason)}); it continues live — list missed events with events.list()`,
                      );
                  }
                } else if (frame.event === "event") {
                  const event = parseFrame<TypedEvent>(Event, frame.data, "event");
                  if (!event) continue;
                  const id = typeof event.id === "string" ? event.id : frame.id;
                  if (id !== undefined && seen.has(id)) continue;
                  if (id !== undefined) {
                    remember(id);
                    state.lastEventId = id;
                  }
                  state.yielded = true;
                  yield event;
                  if (stop.signal.aborted) return;
                }
                // other event names are ignored (forward compatibility)
              }
            }
          } finally {
            reader.cancel().catch(() => {});
          }
        } catch (e) {
          if (stop.signal.aborted) return;
          if (!isRetryableStreamError(e)) throw e;
          error = e as NearPayError;
        } finally {
          if (idle) clearTimeout(idle);
          stop.signal.removeEventListener("abort", onStop);
          conn.abort();
        }
        if (!reconnect) {
          if (error) throw error;
          return;
        }
        let delay: number;
        if (error || !gotReady) {
          delay = backoffMs(failures, baseMs, maxMs);
          const retryAfter = error ? parseRetryAfter(error.headers["retry-after"]) : null;
          if (retryAfter !== null) delay = Math.max(delay, Math.min(retryAfter, maxMs));
          failures++;
        } else delay = state.retryMs;
        options.onReconnect?.({
          attempt: error || !gotReady ? failures : 0,
          delayMs: delay,
          error,
          lastEventId: state.lastEventId,
        });
        await abortableSleep(delay, stop.signal);
      }
    } finally {
      stop.abort();
    }
  }

  const gen = run();
  return {
    get lastEventId() {
      return state.lastEventId;
    },
    get ready() {
      return state.ready;
    },
    get connections() {
      return state.connections;
    },
    get closed() {
      return stop.signal.aborted;
    },
    close() {
      stop.abort();
    },
    [Symbol.asyncIterator]() {
      if (state.started) throw new TypeError("an EventStream can be iterated once; open another with events.stream()");
      state.started = true;
      return gen;
    },
  };
}
