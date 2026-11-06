/**
 * HTTP transport (lld/sdks-and-tools.md §1): `fetch` with a per-attempt timeout (30 s), an automatic
 * `Idempotency-Key` (UUIDv4) on POST reused across up to 2 retries (network errors, 409
 * `idempotency_in_progress`, 429, 5xx) with exponential backoff and jitter, `Retry-After` honoured,
 * and `NearPay-Version` pinned per client (api-conventions §4–§6).
 */
import { randomUUID } from "node:crypto";
import { type AnyRoute, buildPath, HEADERS } from "@nearpay/spec";
import { SDK_VERSION } from "../version.js";
import { errorFromResponse, NearPayConnectionError, type NearPayError } from "./errors.js";

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
}

export interface RouteInput {
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly query?: Readonly<Record<string, unknown>> | undefined;
  readonly body?: unknown;
}

/** Keys appended `key[]=v` (arrays) or `key=v`; `created[gte]` style keys pass through unchanged. */
export function encodeQuery(query: Readonly<Record<string, unknown>> | undefined): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) sp.append(`${k}[]`, String(item));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Routes that carry an Idempotency-Key: every POST (LLD §1) and other idempotent writes (PATCH). */
export function carriesIdempotencyKey(route: Pick<AnyRoute, "method" | "idempotent">): boolean {
  return route.method === "POST" || (route.method !== "GET" && route.idempotent);
}

/** Whether a failed response may be retried with the same key (LLD §1). */
export function isRetryableStatus(status: number, code: string | undefined): boolean {
  if (status === 409) return code === "idempotency_in_progress";
  return status === 429 || status >= 500;
}

/** `Retry-After` in milliseconds (delta seconds or HTTP date), or null. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Exponential backoff with full-ish jitter: base·2^n scaled by [0.5, 1), capped. */
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

export class Transport {
  readonly #o: TransportOptions;

  constructor(o: TransportOptions) {
    this.#o = o;
  }

  get options(): TransportOptions {
    return this.#o;
  }

  /** Calls a spec route; resolves with the parsed body (`undefined` for 204) or throws a `NearPayError`. */
  async request<T>(route: AnyRoute, input: RouteInput = {}, opts: RequestOptions = {}): Promise<T> {
    const o = this.#o;
    const url = `${o.baseUrl}${buildPath(route, input.params ?? {})}${encodeQuery(input.query)}`;
    const anonymous = route.auth.every((a) => a === "anonymous");
    const idempotencyKey = carriesIdempotencyKey(route) ? (opts.idempotencyKey ?? randomUUID()) : undefined;
    const maxRetries = Math.max(0, opts.maxRetries ?? o.maxRetries);
    const timeoutMs = opts.timeoutMs ?? o.timeoutMs;
    const sleep = o.sleep ?? defaultSleep;

    const headers: Record<string, string> = {
      Accept: "application/json",
      [HEADERS.apiVersion]: opts.apiVersion ?? o.apiVersion,
      "User-Agent": `nearpay-node/${SDK_VERSION} node/${process.versions.node}${o.appInfo ? ` ${o.appInfo}` : ""}`,
    };
    if (!anonymous) headers[HEADERS.authorization] = `Bearer ${o.apiKey}`;
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
        if (attempt < maxRetries) {
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
      try {
        parsed = await readBody(res);
      } catch (e) {
        // the connection dropped mid-body: same as a network error
        if (attempt < maxRetries && !opts.signal?.aborted) {
          await sleep(backoffMs(attempt, o.retryBaseMs, o.retryMaxMs));
          continue;
        }
        throw new NearPayConnectionError({ message: `response from ${route.id} was cut off`, cause: e });
      }

      if (res.ok) {
        const meta: ResponseMeta = {
          statusCode: res.status,
          requestId: resHeaders[HEADERS.requestId.toLowerCase()],
          idempotencyKey,
          idempotentReplayed: resHeaders[HEADERS.idempotentReplayed.toLowerCase()] === "true",
          headers: resHeaders,
          attempts: attempt + 1,
        };
        return withMeta((res.status === 204 ? undefined : parsed) as T, meta);
      }

      const err: NearPayError = errorFromResponse(res.status, resHeaders, parsed);
      if (attempt < maxRetries && isRetryableStatus(res.status, err.code)) {
        const retryAfter = parseRetryAfter(resHeaders[HEADERS.retryAfter.toLowerCase()]);
        const wait = Math.max(backoffMs(attempt, o.retryBaseMs, o.retryMaxMs), Math.min(retryAfter ?? 0, o.retryMaxMs));
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}
