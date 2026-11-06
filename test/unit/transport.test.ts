import { API_VERSION, listWebhookSigningKeys } from "@nearpay/spec";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  backoffMs,
  carriesIdempotencyKey,
  encodeQuery,
  isRetryableStatus,
  parseRetryAfter,
  Transport,
} from "../../src/http/transport.js";
import {
  NearPay,
  NearPayApiError,
  NearPayConnectionError,
  NearPayIdempotencyError,
  NearPayInvalidRequestError,
  NearPayRateLimitError,
  NearPayStateConflictError,
  SDK_VERSION,
} from "../../src/index.js";
import { empty, envelope, hangUp, json, type ScriptedServer, scriptedServer, stall, text } from "../support/server.js";

const KEY = "sk_test_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
const PI = "pi_01jbz9k3m4n5p6q7r8s9t0v1w2";
const CS = "cs_01jbz9k3m4n5p6q7r8s9t0v1w2";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let srv: ScriptedServer;
const waits: number[] = [];

function client(extra: Record<string, unknown> = {}) {
  return new NearPay(KEY, { baseUrl: srv.url, retryBaseMs: 1, retryMaxMs: 4, ...extra });
}

beforeAll(async () => {
  srv = await scriptedServer();
});
afterAll(() => srv.close());
afterEach(() => {
  srv.requests.splice(0);
  waits.splice(0);
});

describe("request shape", () => {
  it("sends the key, the pinned version, a User-Agent and a JSON body with a UUIDv4 Idempotency-Key on POST", async () => {
    srv.push(json(201, { id: CS, object: "checkout_session" }, { "x-request-id": "req_abc" }));
    const s = await client({ appInfo: "merchant-demo/1.0" }).checkout.sessions.create({
      amount: 200,
      currency: "usd",
      success_url: "https://shop.example/ok",
    });
    expect(s.id).toBe(CS);
    const r = srv.requests[0];
    expect(r?.method).toBe("POST");
    expect(r?.url).toBe("/v1/checkout/sessions");
    expect(r?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r?.headers["nearpay-version"]).toBe(API_VERSION);
    expect(r?.headers["user-agent"]).toMatch(new RegExp(`^nearpay-node/${SDK_VERSION} node/\\S+ merchant-demo/1.0$`));
    expect(r?.headers["content-type"]).toBe("application/json");
    expect(r?.headers.accept).toBe("application/json");
    expect(r?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(JSON.parse(r?.body ?? "")).toEqual({ amount: 200, currency: "usd", success_url: "https://shop.example/ok" });
    expect(s.lastResponse).toMatchObject({ statusCode: 201, requestId: "req_abc", attempts: 1 });
    expect(JSON.stringify(s)).not.toContain("lastResponse");
  });

  it("uses a caller-provided Idempotency-Key and reports replays", async () => {
    srv.push(json(200, { id: PI, object: "payment_intent" }, { "idempotent-replayed": "true" }));
    const pi = await client().paymentIntents.cancel(PI, { cancellation_reason: "dup" }, { idempotencyKey: "order-42" });
    expect(srv.requests[0]?.headers["idempotency-key"]).toBe("order-42");
    expect(srv.requests[0]?.url).toBe(`/v1/payment_intents/${PI}/cancel`);
    expect(pi.lastResponse?.idempotentReplayed).toBe(true);
    expect(pi.lastResponse?.idempotencyKey).toBe("order-42");
  });

  it("sends {} for a POST without parameters", async () => {
    srv.push(json(200, { id: CS }));
    await client().checkout.sessions.expire(CS);
    expect(srv.requests[0]?.body).toBe("{}");
  });

  it("encodes list queries in the API's notation and sends no key or body on GET", async () => {
    srv.push(json(200, { object: "list", data: [], has_more: false, url: "/v1/checkout/sessions" }));
    await client().checkout.sessions.list({
      limit: 5,
      "created[gte]": 1793873400,
      expand: ["payment_intent"],
      starting_after: undefined,
    });
    const r = srv.requests[0];
    expect(r?.url).toBe("/v1/checkout/sessions?limit=5&created%5Bgte%5D=1793873400&expand%5B%5D=payment_intent");
    expect(r?.headers["idempotency-key"]).toBeUndefined();
    expect(r?.headers["content-type"]).toBeUndefined();
    expect(r?.body).toBe("");
  });

  it("calls GET routes without a query", async () => {
    srv.push(json(200, { id: PI }));
    await client().paymentIntents.retrieve(PI);
    expect(srv.requests[0]?.url).toBe(`/v1/payment_intents/${PI}`);
  });

  it("sends an Idempotency-Key on PATCH and none (and no body) on DELETE; 204 resolves undefined", async () => {
    srv.push(json(200, { id: "we_1" }), empty(204));
    const np = client();
    await np.webhookEndpoints.update("we_01jbz9k3m4n5p6q7r8s9t0v1w2", { disabled: true });
    const gone = await np.webhookEndpoints.del("we_01jbz9k3m4n5p6q7r8s9t0v1w2");
    expect(gone).toBeUndefined();
    expect(srv.requests[0]?.method).toBe("PATCH");
    expect(srv.requests[0]?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(srv.requests[1]?.method).toBe("DELETE");
    expect(srv.requests[1]?.headers["idempotency-key"]).toBeUndefined();
    expect(srv.requests[1]?.body).toBe("");
  });

  it("does not send the key to anonymous routes", async () => {
    srv.push(json(200, { keys: [] }));
    await client().webhookSigningKeys.list();
    expect(srv.requests[0]?.url).toBe(listWebhookSigningKeys.path);
    expect(srv.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("allows a per-call API version", async () => {
    srv.push(json(200, { id: PI }));
    await client().paymentIntents.retrieve(PI, { apiVersion: "2027-01-01" });
    expect(srv.requests[0]?.headers["nearpay-version"]).toBe("2027-01-01");
  });

  it("rejects an empty path parameter before calling the API", async () => {
    await expect(client().paymentIntents.retrieve("")).rejects.toThrow(TypeError);
    expect(srv.requests).toHaveLength(0);
  });

  it("returns non-JSON success bodies as text", async () => {
    srv.push(text(200, "plain"));
    await expect(client().paymentIntents.retrieve(PI)).resolves.toBe("plain");
  });
});

describe("retries", () => {
  it("reuses the same Idempotency-Key across retries of 5xx, 429 and 409 idempotency_in_progress", async () => {
    srv.push(
      json(500, envelope("api_error", "api_error")),
      json(409, envelope("idempotency_error", "idempotency_in_progress"), { "retry-after": "0" }),
      json(201, { id: CS }),
    );
    const s = await client().checkout.sessions.create({ amount: 1, currency: "usd", success_url: "https://a.example" });
    expect(srv.requests).toHaveLength(3);
    const keys = new Set(srv.requests.map((r) => r.headers["idempotency-key"]));
    expect(keys.size).toBe(1);
    expect(s.lastResponse?.attempts).toBe(3);
  });

  it("honours Retry-After on 429 (capped by retryMaxMs)", async () => {
    srv.push(json(429, envelope("rate_limit_error", "rate_limited"), { "retry-after": "1" }), json(200, { id: PI }));
    const np = new NearPay(KEY, { baseUrl: srv.url, retryBaseMs: 1, retryMaxMs: 50 });
    const started = Date.now();
    await np.paymentIntents.retrieve(PI);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(srv.requests).toHaveLength(2);
  });

  it("gives up after maxRetries with the typed error and its request id", async () => {
    srv.push(
      json(503, envelope("rail_unavailable", "rail_unavailable")),
      json(503, envelope("rail_unavailable", "rail_unavailable")),
      json(500, envelope("api_error", "api_error", "boom", { request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w3" })),
    );
    const err = await client()
      .paymentIntents.retrieve(PI)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NearPayApiError);
    expect((err as NearPayApiError).requestId).toBe("req_01jbz9k3m4n5p6q7r8s9t0v1w3");
    expect((err as NearPayApiError).statusCode).toBe(500);
    expect(srv.requests).toHaveLength(3);
  });

  it("does not retry 4xx errors other than 409 idempotency_in_progress and 429", async () => {
    srv.push(
      json(409, envelope("state_conflict", "attempt_in_flight")),
      json(409, envelope("idempotency_error", "idempotency_key_reused")),
      json(404, envelope("invalid_request_error", "resource_missing", "No such payment_intent")),
    );
    const np = client();
    await expect(np.paymentIntents.cancel(PI)).rejects.toBeInstanceOf(NearPayStateConflictError);
    await expect(np.paymentIntents.cancel(PI)).rejects.toBeInstanceOf(NearPayIdempotencyError);
    const e = await np.paymentIntents.retrieve(PI).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayInvalidRequestError);
    expect((e as NearPayInvalidRequestError).code).toBe("resource_missing");
    expect(srv.requests).toHaveLength(3);
  });

  it("respects maxRetries: 0 per call", async () => {
    srv.push(json(429, envelope("rate_limit_error", "rate_limited")));
    await expect(client().paymentIntents.retrieve(PI, { maxRetries: 0 })).rejects.toBeInstanceOf(NearPayRateLimitError);
    expect(srv.requests).toHaveLength(1);
  });

  it("retries network errors and then throws a connection error", async () => {
    srv.push(hangUp, hangUp, hangUp);
    const e = await client()
      .checkout.sessions.create({ amount: 1, currency: "usd", success_url: "https://a.example" })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayConnectionError);
    expect((e as NearPayConnectionError).timedOut).toBe(false);
    expect((e as NearPayConnectionError).type).toBe("connection_error");
    expect(srv.requests).toHaveLength(3);
    expect(new Set(srv.requests.map((r) => r.headers["idempotency-key"])).size).toBe(1);
  });

  it("recovers when a retry after a network error succeeds", async () => {
    srv.push(hangUp, json(200, { id: PI }));
    await expect(client().paymentIntents.retrieve(PI)).resolves.toMatchObject({ id: PI });
  });

  it("times out each attempt and retries", async () => {
    srv.push(stall, json(200, { id: PI }));
    const pi = await client({ timeoutMs: 100 }).paymentIntents.retrieve(PI);
    expect(pi.lastResponse?.attempts).toBe(2);
  });

  it("reports a timeout when every attempt stalls", async () => {
    srv.push(stall, stall);
    const e = await client({ timeoutMs: 50, maxRetries: 1 })
      .paymentIntents.retrieve(PI)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayConnectionError);
    expect((e as NearPayConnectionError).timedOut).toBe(true);
    expect((e as Error).message).toMatch(/timed out after 50 ms/);
  });

  it("does not retry after the caller aborts", async () => {
    srv.push(stall);
    const ac = new AbortController();
    const p = client().paymentIntents.retrieve(PI, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayConnectionError);
    expect((e as Error).message).toMatch(/aborted/);
    expect(srv.requests).toHaveLength(1);
  });

  it("treats a body cut off mid-stream as a network error", async () => {
    const cut = (_r: unknown, res: import("node:http").ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      res.write('{"id":');
      setTimeout(() => res.socket?.destroy(), 10);
    };
    srv.push(cut, cut);
    const e = await client({ maxRetries: 1 })
      .paymentIntents.retrieve(PI)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayConnectionError);
    expect((e as Error).message).toMatch(/cut off/);
    expect(srv.requests).toHaveLength(2);
    srv.push(cut, json(200, { id: PI }));
    await expect(client({ maxRetries: 1 }).paymentIntents.retrieve(PI)).resolves.toMatchObject({ id: PI });
  });

  it("uses the injected sleep for backoff", async () => {
    const t = new Transport({
      apiKey: KEY,
      baseUrl: srv.url,
      apiVersion: API_VERSION,
      timeoutMs: 1000,
      maxRetries: 2,
      fetch,
      retryBaseMs: 100,
      retryMaxMs: 1000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    srv.push(json(502, {}), json(502, {}), json(200, { keys: [] }));
    await t.request(listWebhookSigningKeys);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(50);
    expect(waits[0]).toBeLessThanOrEqual(100);
    expect(waits[1]).toBeGreaterThanOrEqual(100);
    expect(waits[1]).toBeLessThanOrEqual(200);
    expect(t.options.maxRetries).toBe(2);
  });
});

describe("helpers", () => {
  it("encodeQuery", () => {
    expect(encodeQuery(undefined)).toBe("");
    expect(encodeQuery({})).toBe("");
    expect(encodeQuery({ a: null, b: undefined })).toBe("");
    expect(encodeQuery({ expand: ["x", "y"], limit: 3 })).toBe("?expand%5B%5D=x&expand%5B%5D=y&limit=3");
  });

  it("carriesIdempotencyKey", () => {
    expect(carriesIdempotencyKey({ method: "POST", idempotent: false })).toBe(true);
    expect(carriesIdempotencyKey({ method: "PATCH", idempotent: true })).toBe(true);
    expect(carriesIdempotencyKey({ method: "DELETE", idempotent: false })).toBe(false);
    expect(carriesIdempotencyKey({ method: "GET", idempotent: true })).toBe(false);
  });

  it("isRetryableStatus", () => {
    expect(isRetryableStatus(409, "idempotency_in_progress")).toBe(true);
    expect(isRetryableStatus(409, "state_conflict")).toBe(false);
    expect(isRetryableStatus(429, "rate_limited")).toBe(true);
    expect(isRetryableStatus(500, undefined)).toBe(true);
    expect(isRetryableStatus(503, "rail_unavailable")).toBe(true);
    expect(isRetryableStatus(400, "invalid_request")).toBe(false);
  });

  it("parseRetryAfter", () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("soon")).toBeNull();
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(parseRetryAfter("Fri, 06 Nov 2026 12:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Fri, 06 Nov 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("backoffMs grows exponentially with jitter and a cap", () => {
    expect(backoffMs(0, 500, 8000, () => 0)).toBe(250);
    expect(backoffMs(0, 500, 8000, () => 0.999999)).toBe(500);
    expect(backoffMs(2, 500, 8000, () => 0)).toBe(1000);
    expect(backoffMs(10, 500, 8000, () => 0.999999)).toBe(8000);
  });
});
