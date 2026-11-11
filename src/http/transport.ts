/**
 * HTTP transport (lld/sdks-and-tools.md §1, api-conventions §4–§6).
 *
 * - `fetch` with a per-attempt timeout (30 s) and `NearPay-Version` pinned per client.
 * - An automatic `Idempotency-Key` (UUIDv4) on every POST and on idempotent PATCH, reused across
 *   the SDK's own retries.
 * - Retries (up to 2, exponential backoff with jitter, `Retry-After` honoured up to the cap) only
 *   where repeating the request cannot apply it twice:
 *   - the server says it did not process the request: 429 (unless the catalogue marks the code
 *     non-retryable, e.g. `too_many_attempts`) and 409 `idempotency_in_progress`;
 *   - the connection failed before the request was sent (refused, DNS);
 *   - otherwise (5xx, timeouts, connection dropped, body cut off) only for replay-safe routes:
 *     GET, DELETE, and routes that honour the Idempotency-Key (`route.idempotent`). A non-idempotent
 *     POST (the x402 facilitator calls) is not repeated after the server may have acted on it.
 *   Catalogue codes marked `retryable: false` are never retried; caller aborts are never retried.
 * - Responses are parsed tolerantly with the route's spec schema (`./parse.ts`).
 * - Routes with a `binaryResponse` (invoice PDFs, spec 0.3.0) resolve with the raw bytes
 *   (`Uint8Array` + `lastResponse`, `contentType`, `filename`); errors stay JSON.
 * - Routes with an SSE `stream` are opened with `connect` (no retries here: `src/events/stream.ts`
 *   owns reconnection and resume).
 */
import { randomUUID } from "node:crypto";
import { type AnyRoute, buildPath, HEADERS, type UnknownEnumValue } from "@nearpay-money/spec";
import { SDK_VERSION } from "../version.js";
import {
  catalogueEntry,
  errorFromResponse,
  NearPayConnectionError,
  type NearPayError,
  NearPayResponseValidationError,
} from "./errors.js";
import { describeIssues, parseTolerantBody, type ResponseValidation, type ValidationIssue } from "./parse.js";

/** Reported when a response does not match the spec (see `responseValidation`). */
export interface ValidationIssueReport {
  /** Spec route id, e.g. `getRefund`. */
  readonly routeId: string;
  readonly statusCode: number;
  readonly requestId: string | undefined;
  readonly issues: readonly ValidationIssue[];
}

export interface TransportOptions {
  readonly apiKey: string;
  /** API origin, e.g. `https://api.nearpay.money` (no trailing `/v1`). */
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly fetch: typeof fetch;
  /** Appended to the User-Agent (`my-app/1.2`). */
  readonly appInfo?: string | undefined;
  /** Backoff base and cap (tests shorten them). */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Response parsing mode; default `"tolerant"`. */
  readonly responseValidation?: ResponseValidation | undefined;
  /** Called for every response that does not match the spec; default: one process warning per route. */
  readonly onValidationIssue?: ((report: ValidationIssueReport) => void) | undefined;
}

/** Per-call options (last argument of every resource method). */
export interface RequestOptions {
  /** Idempotency-Key for this call; default: a fresh UUIDv4 reused across the SDK's own retries. */
  readonly idempotencyKey?: string;
  /** Per-attempt timeout; default from the client (30 s). */
  readonly timeoutMs?: number;
  /** Retries after the first attempt; default from the client (2). */
  readonly maxRetries?: number;
  /** Aborts the call (no retry after an abort). */
  readonly signal?: AbortSignal;
  /** Override the pinned `NearPay-Version` for this call. */
  readonly apiVersion?: string;
}

/** What the SDK knows about the HTTP exchange behind a result (`lastResponse` on returned objects). */
export interface ResponseMeta {
  readonly statusCode: number;
  readonly requestId: string | undefined;
  readonly idempotencyKey: string | undefined;
  /** `Idempotent-Replayed: true`: the API replayed a stored response for this key. */
  readonly idempotentReplayed: boolean;
  readonly headers: Readonly<Record<string, string>>;
  /** Attempts made (1 = no retry). */
  readonly attempts: number;
  /** Open-enum values (and event types) this SDK's spec version does not know, kept as received. */
  readonly unknownEnumValues: readonly UnknownEnumValue[];
  /** Fields that do not match the spec (`responseValidation: "tolerant"`; the body is returned as received). */
  readonly validationIssues: readonly ValidationIssue[];
}

export interface RouteInput {
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly query?: Readonly<Record<string, unknown>> | undefined;
  readonly body?: unknown;
}

/** Result of a binary route (`invoices.pdf`): the bytes, with the response metadata. */
export type BinaryResult = Uint8Array & {
  readonly lastResponse?: ResponseMeta;
  /** `Content-Type` as received (e.g. `application/pdf`). */
  readonly contentType?: string;
  /** File name from `Content-Disposition` (e.g. `INV-00042.pdf`), when the API sent one. */
  readonly filename?: string;
};

/** Options of `Transport.connect` (SSE routes). */
export interface ConnectOptions {
  readonly signal?: AbortSignal | undefined;
  readonly apiVersion?: string | undefined;
  /** Extra request headers (e.g. `Last-Event-ID`). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Connect timeout (until the response headers arrive); default the client's `timeoutMs`. */
  readonly timeoutMs?: number | undefined;
}

/** File name of a `Content-Disposition: attachment; filename="…"` header. */
export function filenameOf(disposition: string | undefined): string | undefined {
  if (!disposition) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(disposition);
  const name = plain?.[2] ?? plain?.[1]?.trim();
  return name && name.length > 0 ? name : undefined;
}

function appendQuery(sp: URLSearchParams, key: string, v: unknown): void {
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) {
    for (const item of v) sp.append(`${key}[]`, String(item));
  } else if (typeof v === "object") {
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) appendQuery(sp, `${key}[${k}]`, inner);
  } else sp.append(key, String(v));
}

/**
 * Query string in the API's notation (api-conventions §2): arrays `key[]=v`; objects `key[sub]=v`
 * (`{created: {gte: 1}}` → `created[gte]=1`, `{metadata: {order: "42"}}` → `metadata[order]=42`);
 * flat keys such as `created[gte]` pass through unchanged.
 */
export function encodeQuery(query: Readonly<Record<string, unknown>> | undefined): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) appendQuery(sp, k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Routes that carry an Idempotency-Key: every POST (api-conventions §4) and other idempotent writes (PATCH). */
export function carriesIdempotencyKey(route: Pick<AnyRoute, "method" | "idempotent">): boolean {
  return route.method === "POST" || (route.method !== "GET" && route.idempotent);
}

/**
 * POSTs without Idempotency-Key support that are still safe to repeat (spec 0.2.1 note on the
 * node CR "x402Verify/x402Settle idempotent"): `x402Verify` only checks a payload (no state change;
 * results are cached 60 s). `x402Settle` is idempotent on the payload hash, but a repeat after an
 * unknown outcome answers `replayed: true`, which a paywall must treat as "already delivered" — the
 * SDK cannot tell its own earlier attempt from another request's, so settle is not retried after a
 * 5xx/timeout (the caller decides, with `lastResponse.attempts`). The near-intents verify issues a
 * quote and is not repeated either.
 */
export const REPLAY_SAFE_POSTS: ReadonlySet<string> = new Set(["x402Verify"]);

/** Whether repeating the request cannot apply it twice: GET, DELETE, or a route honouring Idempotency-Key. */
export function isReplaySafe(route: Pick<AnyRoute, "method" | "idempotent"> & { readonly id?: string }): boolean {
  return (
    route.method === "GET" ||
    route.method === "DELETE" ||
    route.idempotent ||
    (route.id !== undefined && REPLAY_SAFE_POSTS.has(route.id))
  );
}

/** Whether a failed response's status/code is one a retry can fix (catalogue `retryable`, else 429/5xx). */
export function isRetryableStatus(status: number, code: string | undefined): boolean {
  const entry = catalogueEntry(code);
  if (entry) return entry.retryable;
  if (status === 409) return code === "idempotency_in_progress";
  return status === 429 || status >= 500;
}

/** Whether the SDK retries this failed response for this route (see the module comment). */
export function shouldRetryResponse(
  route: Pick<AnyRoute, "method" | "idempotent"> & { readonly id?: string },
  status: number,
  code: string | undefined,
): boolean {
  if (!isRetryableStatus(status, code)) return false;
  const notProcessed = status === 429 || code === "idempotency_in_progress";
  return notProcessed || isReplaySafe(route);
}

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/** A fetch failure that happened before the request reached the server (connection refused, DNS). */
export function failedBeforeSending(e: unknown): boolean {
  for (let c: unknown = e, depth = 0; c && depth < 4; c = (c as { cause?: unknown }).cause, depth++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return true;
  }
  return false;
}

/** `Retry-After` in milliseconds (delta seconds or HTTP date), or null. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Exponential backoff with jitter: base·2^n scaled by [0.5, 1), capped. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp * (0.5 + random() * 0.5));
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Adds a non-enumerable `lastResponse` to an object result (JSON.stringify and spreads ignore it). */
function withMeta<T>(value: T, meta: ResponseMeta): T {
  if (typeof value === "object" && value !== null) {
    Object.defineProperty(value, "lastResponse", { value: meta, enumerable: false, configurable: true });
  }
  return value;
}

/** The restricted-key scope a route needs (`restricted_key:<scope>` in its auth list), if any. */
export function restrictedScopeOf(route: Pick<AnyRoute, "auth">): string | undefined {
  const a = route.auth.find((x) => x.startsWith("restricted_key:"));
  return a?.slice("restricted_key:".length);
}

export class Transport {
  readonly #o: TransportOptions;
  readonly #warned = new Set<string>();

  constructor(o: TransportOptions) {
    this.#o = o;
  }

  get options(): TransportOptions {
    return this.#o;
  }

  #report(report: ValidationIssueReport): void {
    if (this.#o.onValidationIssue) {
      this.#o.onValidationIssue(report);
      return;
    }
    if (this.#warned.has(report.routeId)) return;
    this.#warned.add(report.routeId);
    process.emitWarning(
      `NearPay response of ${report.routeId} does not match @nearpay-money/spec (returned as received): ${describeIssues(report.issues)}`,
      { type: "NearPayWarning", code: "NEARPAY_RESPONSE_SHAPE" },
    );
  }

  /** Headers every call carries: Accept, pinned version, User-Agent and (except anonymous routes) the key. */
  #baseHeaders(route: AnyRoute, accept: string, apiVersion: string | undefined): Record<string, string> {
    const o = this.#o;
    const headers: Record<string, string> = {
      Accept: accept,
      [HEADERS.apiVersion]: apiVersion ?? o.apiVersion,
      "User-Agent": `nearpay-node/${SDK_VERSION} node/${process.versions.node}${o.appInfo ? ` ${o.appInfo}` : ""}`,
    };
    if (!route.auth.every((a) => a === "anonymous")) headers[HEADERS.authorization] = `Bearer ${o.apiKey}`;
    return headers;
  }

  /**
   * Opens a streaming (SSE) route: resolves with the open response once its headers arrived, or
   * throws the API's error (`NearPayError`, `retryable` set) / a `NearPayConnectionError`. No retries.
   */
  async connect(route: AnyRoute, input: RouteInput = {}, opts: ConnectOptions = {}): Promise<Response> {
    const o = this.#o;
    const url = `${o.baseUrl}${buildPath(route, input.params ?? {})}${encodeQuery(input.query)}`;
    const headers = { ...this.#baseHeaders(route, "text/event-stream", opts.apiVersion), ...opts.headers };
    const timeoutMs = opts.timeoutMs ?? o.timeoutMs;
    const connectTimeout = new AbortController();
    const timer = setTimeout(() => connectTimeout.abort(), timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, connectTimeout.signal]) : connectTimeout.signal;
    let res: Response;
    try {
      res = await o.fetch(url, { method: route.method, headers, signal, redirect: "error" });
    } catch (e) {
      const timedOut = connectTimeout.signal.aborted && !opts.signal?.aborted;
      throw new NearPayConnectionError({
        message: opts.signal?.aborted
          ? `stream ${route.id} was aborted`
          : timedOut
            ? `stream ${route.id}: no response within ${timeoutMs} ms`
            : `could not reach NearPay for ${route.id}: ${(e as Error).message}`,
        timedOut,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res;
    const resHeaders = headersOf(res);
    const parsed = await readBody(res).catch(() => undefined);
    const scope = res.status === 403 && o.apiKey.startsWith("rk_") ? restrictedScopeOf(route) : undefined;
    throw errorFromResponse(res.status, resHeaders, parsed, scope);
  }

  /** Calls a spec route; resolves with the parsed body (`undefined` for 204) or throws a `NearPayError`. */
  async request<T>(route: AnyRoute, input: RouteInput = {}, opts: RequestOptions = {}): Promise<T> {
    const o = this.#o;
    const url = `${o.baseUrl}${buildPath(route, input.params ?? {})}${encodeQuery(input.query)}`;
    const idempotencyKey = carriesIdempotencyKey(route) ? (opts.idempotencyKey ?? randomUUID()) : undefined;
    const maxRetries = Math.max(0, opts.maxRetries ?? o.maxRetries);
    const timeoutMs = opts.timeoutMs ?? o.timeoutMs;
    const sleep = o.sleep ?? defaultSleep;
    const replaySafe = isReplaySafe(route);
    const binary = route.binaryResponse;

    const headers = this.#baseHeaders(
      route,
      binary ? `${binary.contentType}, application/json` : "application/json",
      opts.apiVersion,
    );
    if (idempotencyKey) headers[HEADERS.idempotencyKey] = idempotencyKey;
    let body: string | undefined;
    if (route.method !== "GET" && route.method !== "DELETE") {
      body = JSON.stringify(input.body ?? {});
      headers["Content-Type"] = "application/json";
    }

    for (let attempt = 0; ; attempt++) {
      const attemptTimeout = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, attemptTimeout]) : attemptTimeout;
      let res: Response;
      try {
        res = await o.fetch(url, { method: route.method, headers, body, signal, redirect: "error" });
      } catch (e) {
        if (opts.signal?.aborted) {
          throw new NearPayConnectionError({ message: `request to ${route.id} was aborted`, cause: e });
        }
        const timedOut = attemptTimeout.aborted;
        if (attempt < maxRetries && (replaySafe || (!timedOut && failedBeforeSending(e)))) {
          await sleep(backoffMs(attempt, o.retryBaseMs, o.retryMaxMs));
          continue;
        }
        throw new NearPayConnectionError({
          message: timedOut
            ? `request to ${route.id} timed out after ${timeoutMs} ms (${attempt + 1} attempt(s))`
            : `could not reach NearPay for ${route.id} (${attempt + 1} attempt(s)): ${(e as Error).message}`,
          timedOut,
          cause: e,
        });
      }

      const resHeaders = headersOf(res);
      let parsed: unknown;
      let bytes: Uint8Array | undefined;
      try {
        if (res.ok && binary) bytes = new Uint8Array(await res.arrayBuffer());
        else parsed = await readBody(res);
      } catch (e) {
        // the connection dropped mid-body: the server answered, so only replay-safe routes retry
        if (attempt < maxRetries && replaySafe && !opts.signal?.aborted) {
          await sleep(backoffMs(attempt, o.retryBaseMs, o.retryMaxMs));
          continue;
        }
        throw new NearPayConnectionError({ message: `response from ${route.id} was cut off`, cause: e });
      }

      const requestId = resHeaders[HEADERS.requestId.toLowerCase()];
      if (res.ok && binary && bytes) {
        const contentType = resHeaders["content-type"];
        let validationIssues: readonly ValidationIssue[] = [];
        const mode = o.responseValidation ?? "tolerant";
        const expected = binary.contentType.toLowerCase();
        if (mode !== "off" && !(contentType ?? "").toLowerCase().startsWith(expected)) {
          const issues = [
            {
              path: [],
              message: `expected Content-Type ${expected}, got ${contentType ?? "none"}`,
              code: "content_type",
            },
          ];
          if (mode === "strict") {
            throw new NearPayResponseValidationError({
              message: `response of ${route.id} does not match @nearpay-money/spec: ${describeIssues(issues)}`,
              statusCode: res.status,
              requestId,
              headers: resHeaders,
              raw: bytes,
              issues,
              idempotencyKey,
            });
          }
          validationIssues = issues;
          this.#report({ routeId: route.id, statusCode: res.status, requestId, issues });
        }
        const meta: ResponseMeta = {
          statusCode: res.status,
          requestId,
          idempotencyKey,
          idempotentReplayed: resHeaders[HEADERS.idempotentReplayed.toLowerCase()] === "true",
          headers: resHeaders,
          attempts: attempt + 1,
          unknownEnumValues: [],
          validationIssues,
        };
        const out = withMeta(bytes, meta);
        Object.defineProperty(out, "contentType", { value: contentType, enumerable: false, configurable: true });
        const filename = filenameOf(resHeaders["content-disposition"]);
        Object.defineProperty(out, "filename", { value: filename, enumerable: false, configurable: true });
        return out as T;
      }
      if (res.ok) {
        const value = res.status === 204 ? undefined : parsed;
        let data = value;
        let unknownEnumValues: readonly UnknownEnumValue[] = [];
        let validationIssues: readonly ValidationIssue[] = [];
        const mode = o.responseValidation ?? "tolerant";
        if (mode !== "off" && route.response !== null && value !== undefined) {
          const outcome = parseTolerantBody(route.response, value);
          if (outcome.ok) {
            data = outcome.data;
            unknownEnumValues = outcome.unknown;
          } else if (mode === "strict") {
            throw new NearPayResponseValidationError({
              message: `response of ${route.id} does not match @nearpay-money/spec: ${describeIssues(outcome.issues)}`,
              statusCode: res.status,
              requestId,
              headers: resHeaders,
              raw: value,
              issues: outcome.issues,
              idempotencyKey,
            });
          } else {
            validationIssues = outcome.issues;
            this.#report({ routeId: route.id, statusCode: res.status, requestId, issues: outcome.issues });
          }
        }
        const meta: ResponseMeta = {
          statusCode: res.status,
          requestId,
          idempotencyKey,
          idempotentReplayed: resHeaders[HEADERS.idempotentReplayed.toLowerCase()] === "true",
          headers: resHeaders,
          attempts: attempt + 1,
          unknownEnumValues,
          validationIssues,
        };
        return withMeta(data as T, meta);
      }

      const scope = res.status === 403 && o.apiKey.startsWith("rk_") ? restrictedScopeOf(route) : undefined;
      const err: NearPayError = errorFromResponse(res.status, resHeaders, parsed, scope);
      if (attempt < maxRetries && shouldRetryResponse(route, res.status, err.code)) {
        const retryAfter = parseRetryAfter(resHeaders[HEADERS.retryAfter.toLowerCase()]);
        const wait = Math.max(backoffMs(attempt, o.retryBaseMs, o.retryMaxMs), Math.min(retryAfter ?? 0, o.retryMaxMs));
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}
