/**
 * `events.stream()` (src/events/stream.ts) against a scripted `fetch`: SSE parsing edge cases,
 * resume, dedupe, reconnect/backoff, idle detection, fatal errors and validation modes.
 */
import { describe, expect, it, vi } from "vitest";
import { isRetryableStreamError, NearPay, NearPayConnectionError, NearPayError, SseParser } from "../../src/index.js";
import { event, ids, invoice, streamReady, streamReset } from "../support/fixtures.js";
import { envelopeFor } from "../support/spec-mock.js";

const KEY = "sk_test_stream0123456789";
const evt = (n: number) => `evt_01jbz9k3m4n5p6q7r8s9t0v1${n.toString(32).padStart(2, "0")}`;
const paid = (n: number) => event("invoice.paid", invoice({ status: "paid" }), { id: evt(n) });
const frame = (name: string, data: unknown, id?: string) =>
  `event: ${name}\n${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

type Script = (req: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Response | Promise<Response>;

/** A Response whose body emits `chunks` and then ends (or stays open when `hold`). */
function sse(chunks: string[], hold = false): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (!hold) c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function client(scripts: Script[]) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    requests.push({ url, headers });
    const s = scripts[Math.min(requests.length - 1, scripts.length - 1)];
    if (!s) throw new Error("no script");
    const signal = init.signal as AbortSignal;
    const res = await s({ url, headers, signal });
    // tie the body to the abort signal like undici does
    if (res.body) {
      const reader = res.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          const onAbort = () => c.error(new DOMException("aborted", "AbortError"));
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            const r = await reader.read();
            if (r.done) c.close();
            else c.enqueue(r.value);
          } catch (e) {
            c.error(e);
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        },
        cancel: () => reader.cancel(),
      });
      return new Response(body, { status: res.status, headers: res.headers });
    }
    return res;
  }) as unknown as typeof fetch;
  const np = new NearPay(KEY, { baseUrl: "http://api.test", fetch: fetchImpl });
  return { np, requests };
}

const fast = { reconnectBaseMs: 1, reconnectMaxMs: 4 } as const;

async function take<T>(it: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

describe("SseParser", () => {
  it("handles CRLF/CR/LF, split chunks, multi-line data, comments, ids and retry", () => {
    const p = new SseParser();
    expect(p.push(": hello\r\nretry: 1500\r\n\r\nevent: ev")).toEqual([
      { event: "", data: "", id: undefined, retry: 1500 },
    ]);
    expect(p.push('ent\nid: evt_1\ndata: {"a":\ndata:1}\r')).toEqual([]);
    expect(p.push("\n\r\n")).toEqual([{ event: "event", data: '{"a":\n1}', id: "evt_1", retry: undefined }]);
    expect(p.push("data\n\ndata: x\rdata:y\r\r")).toEqual([
      { event: "message", data: "", id: undefined, retry: undefined },
      { event: "message", data: "x\ny", id: undefined, retry: undefined },
    ]);
    expect(p.push("id: a\0b\nretry: soon\nfoo: bar\ndata: z\n\n")).toEqual([
      { event: "message", data: "z", id: undefined, retry: undefined },
    ]);
    expect(p.push("event: lonely\n\n")).toEqual([]);
  });
});

describe("events.stream", () => {
  it("sends Accept, auth, version and types; yields typed events and the ready frame", async () => {
    const { np, requests } = client([
      () => sse([frame("ready", streamReady({ types: ["invoice.paid"] })), frame("event", paid(1), evt(1))]),
    ]);
    const s = np.events.stream({ types: ["invoice.paid"] }, { reconnect: false });
    const got = await take(s, 5);
    expect(got.map((e) => e.id)).toEqual([evt(1)]);
    expect(s.ready?.types).toEqual(["invoice.paid"]);
    expect(s.connections).toBe(1);
    expect(requests[0]?.url).toBe("http://api.test/v1/events/stream?types=invoice.paid");
    expect(requests[0]?.headers).toMatchObject({
      Accept: "text/event-stream",
      Authorization: `Bearer ${KEY}`,
      "NearPay-Version": expect.any(String),
    });
    expect(requests[0]?.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("starting_after resumes the first connection; later ones send Last-Event-ID", async () => {
    const { np, requests } = client([
      () => sse(["retry: 1\n\n", frame("ready", streamReady()), frame("event", paid(2), evt(2))]),
      () => sse([frame("ready", streamReady()), frame("event", paid(3), evt(3))]),
    ]);
    const s = np.events.stream({ types: "*", starting_after: evt(1) }, fast);
    expect((await take(s, 2)).map((e) => e.id)).toEqual([evt(2), evt(3)]);
    expect(requests[0]?.headers["Last-Event-ID"]).toBe(evt(1));
    expect(requests[0]?.url).toContain("types=*");
    expect(requests[1]?.headers["Last-Event-ID"]).toBe(evt(2));
  });

  it("drops duplicates (at-least-once) and events of unknown types pass through", async () => {
    const future = { ...paid(5), type: "quote.accepted", data: { object: { object: "quote" } } };
    const { np } = client([
      () =>
        sse([
          frame("ready", streamReady()),
          frame("event", paid(4), evt(4)),
          frame("event", paid(4), evt(4)),
          frame("event", future, evt(5)),
          frame("future_frame", { x: 1 }),
        ]),
    ]);
    const got = await take(np.events.stream({}, { reconnect: false }), 5);
    expect(got.map((e) => `${e.type}:${e.id}`)).toEqual([`invoice.paid:${evt(4)}`, `quote.accepted:${evt(5)}`]);
  });

  it("reset: forgets the bad cursor (next reconnect is live-only) and warns once by default", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const { np, requests } = client([
      () => sse(["retry: 1\n\n", frame("ready", streamReady()), frame("reset", streamReset(evt(1), "cursor_unknown"))]),
      () => sse([frame("ready", streamReady()), frame("event", paid(9), evt(9))]),
    ]);
    const s = np.events.stream({ starting_after: evt(1) }, fast);
    expect((await take(s, 1))[0]?.id).toBe(evt(9));
    expect(requests[1]?.headers["Last-Event-ID"]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not resume after .*cursor_unknown/),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("reconnects after 5xx and 429 (Retry-After honoured up to the cap), with backoff and onReconnect", async () => {
    const { np, requests } = client([
      () => new Response(JSON.stringify(envelopeFor("api_error")), { status: 503 }),
      () =>
        new Response(JSON.stringify(envelopeFor("rate_limited")), {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      () => sse([frame("ready", streamReady()), frame("event", paid(1), evt(1))]),
    ]);
    const seen: { attempt: number; delayMs: number; code: string | undefined }[] = [];
    const s = np.events.stream(
      {},
      { ...fast, onReconnect: (r) => seen.push({ attempt: r.attempt, delayMs: r.delayMs, code: r.error?.code }) },
    );
    expect((await take(s, 1))[0]?.id).toBe(evt(1));
    expect(requests).toHaveLength(3);
    expect(seen.map((x) => [x.attempt, x.code])).toEqual([
      [1, "api_error"],
      [2, "rate_limited"],
    ]);
    expect(seen[1]?.delayMs).toBe(4); // Retry-After 1 s, capped by reconnectMaxMs
  });

  it("reconnects after a dropped connection and after a silent one (idle timeout)", async () => {
    const { np, requests } = client([
      () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })),
      () => sse([frame("ready", streamReady())], true), // stays open and silent
      () => sse([frame("ready", streamReady()), frame("event", paid(1), evt(1))]),
    ]);
    const errors: (NearPayError | undefined)[] = [];
    const s = np.events.stream({}, { ...fast, idleTimeoutMs: 30, onReconnect: (r) => errors.push(r.error) });
    expect((await take(s, 1))[0]?.id).toBe(evt(1));
    expect(requests).toHaveLength(3);
    expect(errors[0]).toBeInstanceOf(NearPayConnectionError);
    expect(errors[1]?.message).toMatch(/silent for 30 ms/);
  });

  it("errors a retry cannot fix end the iteration (400 event_type_unknown, 401)", async () => {
    for (const code of ["event_type_unknown", "authentication_required"] as const) {
      const env = envelopeFor(code);
      const status = code === "event_type_unknown" ? 400 : 401;
      const { np, requests } = client([() => new Response(JSON.stringify(env), { status })]);
      const e = await take(np.events.stream({ types: ["nope.nope"] }, fast), 1).catch((x: unknown) => x);
      expect((e as NearPayError).code).toBe(code);
      expect(requests).toHaveLength(1);
    }
    expect(isRetryableStreamError(new Error("x"))).toBe(false);
    expect(isRetryableStreamError(new NearPayError({ message: "x" }))).toBe(true);
  });

  it("reconnect: false ends after a clean close and throws a connection error", async () => {
    const { np } = client([() => sse([frame("ready", streamReady())])]);
    expect(await take(np.events.stream({}, { reconnect: false }), 1)).toEqual([]);
    const failing = client([() => Promise.reject(new TypeError("fetch failed"))]);
    const e = await take(failing.np.events.stream({}, { reconnect: false }), 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayConnectionError);
  });

  it("close() and an aborted signal stop the stream, also while it waits to reconnect", async () => {
    const { np } = client([() => sse([frame("ready", streamReady()), frame("event", paid(1), evt(1))])]);
    const s = np.events.stream({}, { reconnectBaseMs: 60_000, reconnectMaxMs: 60_000 });
    const it = s[Symbol.asyncIterator]();
    expect((await it.next()).value?.id).toBe(evt(1));
    const pending = it.next(); // drains, then sleeps before reconnecting
    setTimeout(() => s.close(), 10);
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(s.closed).toBe(true);
    expect(() => s[Symbol.asyncIterator]()).toThrow(/iterated once/);

    const ac = new AbortController();
    ac.abort();
    const pre = client([() => sse([frame("event", paid(1), evt(1))])]);
    expect(await take(pre.np.events.stream({}, { signal: ac.signal }), 1)).toEqual([]);
    expect(pre.requests).toHaveLength(0);

    const live = new AbortController();
    const held = client([
      ({ signal }) =>
        new Promise<Response>((_r, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
    ]);
    const p = take(held.np.events.stream({}, { signal: live.signal }), 1);
    setTimeout(() => live.abort(), 10);
    expect(await p).toEqual([]);
  });

  it("validation: tolerant passes a broken frame on and reports it; strict throws; off skips parsing", async () => {
    const broken = { ...paid(1), created: "soon" };
    const script = () =>
      sse([
        frame("ready", { object: "event_stream" }),
        frame("event", broken, evt(1)),
        "event: event\ndata: {nope\n\n",
      ]);
    const issues: string[] = [];
    const tolerant = client([script]);
    const got = await take(
      tolerant.np.events.stream({}, { reconnect: false, onValidationIssue: (_i, f) => issues.push(f) }),
      5,
    );
    expect(got.map((e) => e.created as unknown)).toEqual(["soon"]);
    expect(issues).toEqual(["ready", "event", "event"]);

    const strict = client([script]);
    const e = await take(strict.np.events.stream({}, { reconnect: false, validation: "strict" }), 5).catch(
      (x: unknown) => x,
    );
    expect((e as Error).name).toBe("NearPayResponseValidationError");

    const off = client([script]);
    expect(await take(off.np.events.stream({}, { reconnect: false, validation: "off" }), 5)).toHaveLength(1);

    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const dflt = client([script]);
    await take(dflt.np.events.stream({}, { reconnect: false }), 5);
    expect(warn).toHaveBeenCalledTimes(2); // once per frame kind
    warn.mockRestore();
    const strictJson = client([() => sse(["event: event\ndata: {nope\n\n"])]);
    const e2 = await take(strictJson.np.events.stream({}, { reconnect: false, validation: "strict" }), 1).catch(
      (x: unknown) => x,
    );
    expect((e2 as Error).message).toMatch(/not JSON/);
  });

  it("uses the server's retry: delay after a clean close", async () => {
    const { np } = client([
      () => sse(["retry: 7\n\n", frame("ready", streamReady())]),
      () => sse([frame("ready", streamReady()), frame("event", paid(1), evt(1))]),
    ]);
    const delays: number[] = [];
    const s = np.events.stream({}, { ...fast, onReconnect: (r) => delays.push(r.delayMs) });
    await take(s, 1);
    expect(delays).toEqual([7]);
    expect(ids.evt).toMatch(/^evt_/);
  });
});
