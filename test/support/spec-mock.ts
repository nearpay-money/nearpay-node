/**
 * An in-process, spec-validating mock of the NearPay public API for unit tests.
 *
 * Every request is matched to a route of `PUBLIC_ROUTES` and checked the way the gateway and the
 * service bootstrap check it: credential allowed by the route's `auth` (no `Authorization` on
 * anonymous routes; `rk_` keys need the route's scope), `NearPay-Version`, an `Idempotency-Key` on
 * POST / idempotent PATCH, and path params, query and body parsed **strictly** with the route's
 * schemas. A request that fails a check is answered `400 invalid_request` and recorded in
 * `violations` (tests assert it stays empty). Handler results are validated against the route's
 * response schema (a mock cannot drift from the spec); routes with `idempotent: true` replay stored
 * responses for a repeated key (`Idempotent-Replayed: true`) and answer `409 idempotency_key_reused`
 * for a reused key with another body, as api-conventions §4 specifies.
 *
 * Stage 3 (spec 0.3.0): route `headers` (e.g. `Last-Event-ID`) are validated; binary routes answer
 * `{$binary}` (bytes with the route's content type) and SSE routes `{$stream}` (the handler writes
 * frames to the response) — each only on routes that declare it, with the matching `Accept`.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AnyRoute,
  API_VERSION,
  ERRORS,
  type ErrorCode,
  ErrorEnvelope,
  HEADERS,
  PUBLIC_ROUTES,
  type RouteBody,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
} from "@nearpay-money/spec";
import { z } from "zod";

export interface MockRequest<R extends AnyRoute = AnyRoute> {
  readonly route: R;
  readonly params: RouteParams<R>;
  readonly query: RouteQuery<R>;
  readonly body: RouteBody<R>;
  readonly headers: IncomingMessage["headers"];
  readonly idempotencyKey: string | undefined;
  /** The raw query string (as sent). */
  readonly search: string;
}

/** Answer with a typed body (status = the route's), or a full response. */
export type MockReply<R extends AnyRoute> =
  | RouteResponse<R>
  | { readonly $status: number; readonly $body?: unknown; readonly $headers?: Record<string, string> }
  | { readonly $binary: Uint8Array; readonly $contentType?: string; readonly $headers?: Record<string, string> }
  | { readonly $stream: (res: ServerResponse, req: MockRequest<R>) => void | Promise<void> };

/** Writes one SSE frame (`event:`, optional `id:`, `data:` JSON). */
export function sseFrame(event: string, data: unknown, id?: string): string {
  return `event: ${event}\n${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

/** Opens an SSE response the way the webhooks service does (`retry:` first). */
export function openSseResponse(res: ServerResponse, retryMs = 3000): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": "req_stream0000jbz9k3m4n5p6q7r8",
  });
  res.write(`retry: ${retryMs}\n\n`);
}

export type MockHandler<R extends AnyRoute> = (req: MockRequest<R>) => MockReply<R> | Promise<MockReply<R>>;

/** Thrown by a handler to answer with a catalogue error. */
export class MockApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra: {
      readonly param?: string;
      readonly headers?: Record<string, string>;
      readonly status?: number;
    } = {},
  ) {
    super(code);
  }
}

export interface Violation {
  readonly route: string | undefined;
  readonly method: string;
  readonly url: string;
  readonly problem: string;
}

export interface SpecMock {
  readonly url: string;
  /** Requests that reached a handler (or the idempotency store), in order. */
  readonly calls: MockRequest[];
  /** Requests that broke the contract (should stay empty). */
  readonly violations: Violation[];
  /** Raw requests (every attempt, including retries and violations). */
  readonly attempts: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[];
  on<R extends AnyRoute>(route: R, handler: MockHandler<R>): SpecMock;
  /** Queue one-shot responders run before the handler (e.g. a 503, a dropped connection). */
  once(route: AnyRoute, fn: (res: ServerResponse) => void): SpecMock;
  callsTo<R extends AnyRoute>(route: R): MockRequest<R>[];
  /** Scopes held by `rk_` keys (default: every scope). */
  setRestrictedScopes(scopes: readonly string[] | "all"): void;
  reset(): void;
  close(): Promise<void>;
}

let reqSeq = 0;
const requestId = () => `req_${(reqSeq++).toString().padStart(4, "0")}jbz9k3m4n5p6q7r8s9t0v1`;

export function envelopeFor(code: ErrorCode, message?: string, param?: string, reqId = requestId()) {
  const def = ERRORS[code];
  return ErrorEnvelope.parse({
    error: {
      type: def.type,
      code,
      message: message ?? def.example,
      ...(param ? { param } : {}),
      doc_url: `https://docs.nearpay.money/errors/${code}`,
      request_id: reqId,
    },
  });
}

function compile(route: AnyRoute) {
  const names: string[] = [];
  const src = route.path
    .split("/")
    .map((seg) => {
      const m = /^\{([a-z_]+)\}$/.exec(seg);
      if (m) {
        names.push(m[1] as string);
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { route, names, re: new RegExp(`^${src}$`) };
}

// literal segments win over `{param}` ones (`/v1/events/stream` before `/v1/events/{id}`), like the gateway
const TABLE = PUBLIC_ROUTES.map(compile).sort((a, b) => a.names.length - b.names.length);

function queryObject(sp: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of sp) {
    if (k.endsWith("[]")) {
      const key = k.slice(0, -2);
      const arr = (out[key] as string[] | undefined) ?? [];
      arr.push(v);
      out[key] = arr;
    } else out[k] = v;
  }
  return out;
}

export async function startSpecMock(): Promise<SpecMock> {
  const handlers = new Map<string, MockHandler<AnyRoute>>();
  const onceQueue = new Map<string, ((res: ServerResponse) => void)[]>();
  const calls: MockRequest[] = [];
  const violations: Violation[] = [];
  const attempts: SpecMock["attempts"] = [];
  const idem = new Map<string, { hash: string; status: number; body: string; headers: Record<string, string> }>();
  let scopes: readonly string[] | "all" = "all";

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-request-id": requestId(),
      ...headers,
    });
    res.end(text);
    return text;
  };
  const violate = (res: ServerResponse, v: Violation) => {
    violations.push(v);
    send(res, 400, envelopeFor("invalid_request", `mock: ${v.problem}`));
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://mock");
        attempts.push({ method, url: req.url ?? "", headers: req.headers, body: raw });
        const hit = TABLE.map((t) => ({ t, m: t.route.method === method ? t.re.exec(url.pathname) : null })).find(
          (x) => x.m,
        );
        if (!hit?.m) {
          violations.push({ route: undefined, method, url: req.url ?? "", problem: "no such route" });
          send(res, 404, envelopeFor("resource_missing", "mock: no such route"));
          return;
        }
        const route = hit.t.route;
        const v = (problem: string) => violate(res, { route: route.id, method, url: req.url ?? "", problem });

        // credentials (gateway + identity)
        const auth = req.headers.authorization;
        const anonymous = route.auth.every((a) => a === "anonymous");
        if (anonymous) {
          if (auth !== undefined) return v("anonymous routes must be called without credentials");
        } else {
          const key = /^Bearer ((sk|rk)_(test|live)_[0-9A-Za-z]+)$/.exec(auth ?? "");
          if (!key) return v("missing or malformed Bearer key");
          if (key[2] === "sk" && !route.auth.includes("secret_key")) {
            send(res, 403, envelopeFor("permission_denied"));
            return;
          }
          if (key[2] === "rk") {
            const need = route.auth.find((a) => a.startsWith("restricted_key:"))?.slice("restricted_key:".length);
            if (!need || (scopes !== "all" && !scopes.includes(need))) {
              send(res, 403, envelopeFor("permission_denied"));
              return;
            }
          }
        }
        if (req.headers["nearpay-version"] !== API_VERSION) return v("NearPay-Version header missing or not pinned");
        if (!/^nearpay-node\/\S+ node\//.test(String(req.headers["user-agent"]))) return v("unexpected User-Agent");
        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
        const needsKey = method === "POST" || (method !== "GET" && route.idempotent);
        if (needsKey && !idempotencyKey) return v("Idempotency-Key missing");
        if (!needsKey && idempotencyKey) return v("Idempotency-Key on a route that does not take one");
        if (idempotencyKey && idempotencyKey.length > 255) return v("Idempotency-Key longer than 255 chars");
        const accept = String(req.headers.accept ?? "");
        if (route.stream && accept !== "text/event-stream") return v("SSE routes need Accept: text/event-stream");
        if (route.binaryResponse && !accept.includes(route.binaryResponse.contentType)) {
          return v(`binary routes need Accept: ${route.binaryResponse.contentType}`);
        }
        if (!route.stream && !route.binaryResponse && accept !== "application/json")
          return v("Accept must be application/json");
        if (route.headers instanceof z.ZodObject) {
          const picked = Object.fromEntries(
            Object.keys(route.headers.shape).flatMap((k) =>
              req.headers[k] === undefined ? [] : [[k, req.headers[k]]],
            ),
          );
          const h = route.headers.safeParse(picked);
          if (!h.success) return v(`headers: ${JSON.stringify(h.error.issues[0])}`);
        }

        // params, query, body (strict, like the service bootstrap)
        const paramObj = Object.fromEntries(hit.t.names.map((n, i) => [n, decodeURIComponent(hit.m?.[i + 1] ?? "")]));
        let params: unknown;
        if (route.params) {
          const p = route.params.safeParse(paramObj);
          if (!p.success) return v(`params: ${p.error.issues[0]?.message}`);
          params = p.data;
        }
        let query: unknown;
        const qObj = queryObject(url.searchParams);
        if (route.query) {
          const q = route.query.safeParse(qObj);
          if (!q.success) return v(`query: ${JSON.stringify(q.error.issues[0])}`);
          query = q.data;
        } else if (Object.keys(qObj).length > 0) return v("query on a route without one");
        let body: unknown;
        if (method === "GET" || method === "DELETE") {
          if (raw !== "") return v(`${method} with a body`);
        } else {
          if (req.headers["content-type"] !== "application/json") return v("Content-Type must be application/json");
          let json: unknown;
          try {
            json = JSON.parse(raw);
          } catch {
            return v("body is not JSON");
          }
          if (route.body) {
            const b = route.body.safeParse(json);
            if (!b.success) return v(`body: ${JSON.stringify(b.error.issues[0])}`);
            body = b.data;
          }
        }

        // idempotency store (routes that honour the key)
        const storeKey = idempotencyKey && route.idempotent ? `${auth}|${idempotencyKey}` : undefined;
        const hash = createHash("sha256").update(`${method} ${url.pathname} ${raw}`).digest("hex");
        const mreq: MockRequest = {
          route,
          params: params as never,
          query: query as never,
          body: body as never,
          headers: req.headers,
          idempotencyKey,
          search: url.search,
        };
        if (storeKey) {
          const stored = idem.get(storeKey);
          if (stored && stored.hash !== hash) {
            send(res, 409, envelopeFor("idempotency_key_reused"));
            return;
          }
          if (stored) {
            calls.push(mreq);
            res.writeHead(stored.status, { ...stored.headers, [HEADERS.idempotentReplayed.toLowerCase()]: "true" });
            res.end(stored.body);
            return;
          }
        }

        const queued = onceQueue.get(route.id);
        const first = queued?.shift();
        if (first) {
          first(res);
          return;
        }
        calls.push(mreq);
        const handler = handlers.get(route.id);
        if (!handler) {
          violations.push({ route: route.id, method, url: req.url ?? "", problem: "route not mocked" });
          send(res, 500, envelopeFor("api_error", "mock: route not mocked"));
          return;
        }
        let reply: unknown;
        try {
          reply = await handler(mreq);
        } catch (e) {
          if (e instanceof MockApiError) {
            const def = ERRORS[e.code];
            send(res, e.extra.status ?? def.status, envelopeFor(e.code, undefined, e.extra.param), e.extra.headers);
            return;
          }
          throw e;
        }
        let status: number = route.status;
        let out: unknown = reply;
        let headers: Record<string, string> = {};
        if (typeof reply === "object" && reply !== null && "$stream" in reply) {
          if (!route.stream) return v("mock: $stream reply on a route without a stream");
          await (reply as { $stream: (res: ServerResponse, req: MockRequest) => void | Promise<void> }).$stream(
            res,
            mreq,
          );
          return;
        }
        if (route.stream) {
          violations.push({
            route: route.id,
            method,
            url: req.url ?? "",
            problem: "mock: stream route needs a $stream reply",
          });
          send(res, 500, envelopeFor("api_error", "mock: invalid response"));
          return;
        }
        if (typeof reply === "object" && reply !== null && "$binary" in reply) {
          const b = reply as { $binary: Uint8Array; $contentType?: string; $headers?: Record<string, string> };
          if (!route.binaryResponse) return v("mock: $binary reply on a JSON route");
          res.writeHead(route.status, {
            "content-type": b.$contentType ?? route.binaryResponse.contentType,
            "x-request-id": requestId(),
            ...b.$headers,
          });
          res.end(Buffer.from(b.$binary));
          return;
        }
        if (typeof reply === "object" && reply !== null && "$status" in reply) {
          const r = reply as { $status: number; $body?: unknown; $headers?: Record<string, string> };
          status = r.$status;
          out = r.$body;
          headers = r.$headers ?? {};
        } else if (route.response === null) {
          out = undefined;
        } else {
          const check = route.response.safeParse(reply);
          if (!check.success) {
            violations.push({
              route: route.id,
              method,
              url: req.url ?? "",
              problem: `mock response does not match the spec: ${JSON.stringify(check.error.issues.slice(0, 3))}`,
            });
            send(res, 500, envelopeFor("api_error", "mock: invalid response"));
            return;
          }
        }
        const reqIdHeader = { "x-request-id": requestId(), ...headers };
        const text = send(res, status, out, reqIdHeader);
        if (storeKey && status < 500) {
          idem.set(storeKey, {
            hash,
            status,
            body: text,
            headers: { ...(out === undefined ? {} : { "content-type": "application/json" }), ...reqIdHeader },
          });
        }
      })().catch((e: unknown) => {
        violations.push({ route: undefined, method: req.method ?? "", url: req.url ?? "", problem: String(e) });
        if (!res.headersSent) send(res, 500, envelopeFor("api_error", "mock: handler crashed"));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const mock: SpecMock = {
    url: `http://127.0.0.1:${port}`,
    calls,
    violations,
    attempts,
    on(route, handler) {
      handlers.set(route.id, handler as unknown as MockHandler<AnyRoute>);
      return mock;
    },
    once(route, fn) {
      const q = onceQueue.get(route.id) ?? [];
      q.push(fn);
      onceQueue.set(route.id, q);
      return mock;
    },
    callsTo<R extends AnyRoute>(route: R) {
      return calls.filter((c) => c.route.id === route.id) as unknown as MockRequest<R>[];
    },
    setRestrictedScopes(s) {
      scopes = s;
    },
    reset() {
      handlers.clear();
      onceQueue.clear();
      calls.splice(0);
      violations.splice(0);
      attempts.splice(0);
      idem.clear();
      scopes = "all";
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  return mock;
}
