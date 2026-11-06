import { readFileSync } from "node:fs";
import { type AnyRoute, ERROR_TYPES, PUBLIC_ROUTES } from "@nearpay/spec";
import { describe, expect, expectTypeOf, it } from "vitest";
import { errorFromResponse } from "../../src/http/errors.js";
import { Transport } from "../../src/http/transport.js";
import {
  DEFAULT_BASE_URL,
  NearPay,
  NearPayApiError,
  NearPayAuthenticationError,
  NearPayError,
  NearPayIdempotencyError,
  NearPayInvalidRequestError,
  NearPayPaymentError,
  NearPayPermissionError,
  NearPayRailUnavailableError,
  NearPayRateLimitError,
  NearPayStateConflictError,
  RESOURCES,
  SDK_VERSION,
} from "../../src/index.js";
import { bindRoute, pathParamNames, routesOf } from "../../src/resources/bind.js";

const keyCallable = (r: AnyRoute) => r.auth.some((a) => a === "secret_key" || a.startsWith("restricted_key:"));

describe("resource tree vs the spec route table", () => {
  const bound = routesOf(RESOURCES);

  it("binds every Stage 1 public route a secret or restricted key can call, exactly once", () => {
    const expected = PUBLIC_ROUTES.filter((r) => r.stage === 1 && keyCallable(r))
      .map((r) => r.id)
      .sort();
    const got = bound
      .map((b) => b.route.id)
      .filter((id) => expected.includes(id))
      .sort();
    expect(got).toEqual(expected);
    expect(new Set(bound.map((b) => b.route.id)).size).toBe(bound.length);
  });

  it("binds only public routes callable from a server (key or anonymous), never payer or dashboard-only routes", () => {
    for (const { path, route } of bound) {
      expect(PUBLIC_ROUTES, path).toContain(route);
      expect(keyCallable(route) || route.auth.every((a) => a === "anonymous"), path).toBe(true);
      expect(route.auth, path).not.toContain("client_secret");
      expect(pathParamNames(route).length, path).toBeLessThanOrEqual(1);
    }
  });

  it("exposes the LLD method names", () => {
    expect(bound.map((b) => b.path)).toEqual(
      expect.arrayContaining([
        "checkout.sessions.create",
        "checkout.sessions.retrieve",
        "checkout.sessions.list",
        "checkout.sessions.expire",
        "paymentIntents.retrieve",
        "paymentIntents.list",
        "paymentIntents.cancel",
        "balanceTransactions.list",
        "webhookEndpoints.create",
        "webhookEndpoints.del",
        "events.list",
        "agentPayments.list",
        "testHelpers.paymentAttempts.advance",
      ]),
    );
  });

  it("refuses routes with several path parameters", () => {
    const t = new Transport({
      apiKey: "sk_test_x",
      baseUrl: "http://127.0.0.1:9",
      apiVersion: "2026-11-01",
      timeoutMs: 10,
      maxRetries: 0,
      fetch,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });
    const twoParams = PUBLIC_ROUTES.find((r) => pathParamNames(r).length > 1);
    expect(twoParams).toBeDefined();
    expect(() => bindRoute(t, twoParams as AnyRoute)).toThrow(/more than one path parameter/);
    const m = bindRoute(t, RESOURCES.paymentIntents.retrieve);
    expect(m.name).toBe("getPaymentIntent");
  });
});

describe("method types come from the spec schemas", () => {
  it("derives arguments and results", () => {
    const np = new NearPay("sk_test_types", { fetch: async () => new Response("{}") });
    type CreateArgs = Parameters<typeof np.checkout.sessions.create>;
    expectTypeOf<CreateArgs[0]>().toMatchTypeOf<{ amount: number | string; success_url: string }>();
    type Session = Awaited<ReturnType<typeof np.checkout.sessions.create>>;
    expectTypeOf<Session["id"]>().toEqualTypeOf<`cs_${string}`>();
    type Intent = Awaited<ReturnType<typeof np.paymentIntents.retrieve>>;
    expectTypeOf<Intent["status"]>().toEqualTypeOf<
      "requires_payment" | "processing" | "requires_review" | "succeeded" | "canceled" | "expired"
    >();
    expectTypeOf<Parameters<typeof np.paymentIntents.retrieve>[0]>().toEqualTypeOf<string>();
    type ListQuery = NonNullable<Parameters<typeof np.events.list>[0]>;
    expectTypeOf<ListQuery["limit"]>().toEqualTypeOf<number | undefined>();
    type Deleted = Awaited<ReturnType<typeof np.webhookEndpoints.del>>;
    expectTypeOf<Deleted>().toEqualTypeOf<undefined>();
    // @ts-expect-error the create body is required
    void (() => np.checkout.sessions.create());
    // @ts-expect-error a path parameter is required
    void (() => np.paymentIntents.retrieve());
    // @ts-expect-error unknown body fields are rejected at compile time
    void (() => np.paymentIntents.cancel("pi_x", { reason: "x" }));
    void (() => np.checkout.sessions.expire("cs_x"));
    void (() => np.testHelpers.paymentAttempts.advance("pa_x", { to: "success" }));
  });
});

describe("client", () => {
  it("validates the key", () => {
    expect(() => new NearPay("")).toThrow(/API key/);
    expect(() => new NearPay(undefined as unknown as string)).toThrow(/API key/);
    expect(() => new NearPay("pk_test_abc")).toThrow(/publishable/);
    expect(() => new NearPay("whsec_abc")).toThrow(/sk_test_/);
    expect(new NearPay("sk_test_abc").livemode).toBe(false);
    expect(new NearPay("rk_live_abc").livemode).toBe(true);
  });

  it("normalises and validates the base URL", async () => {
    expect(() => new NearPay("sk_test_abc", { baseUrl: "ftp://x" })).toThrow(/baseUrl/);
    const seen: string[] = [];
    const np = new NearPay("sk_test_abc", {
      baseUrl: "https://api.nearpay.localhost///",
      fetch: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
      },
    });
    await np.assets.list();
    expect(seen).toEqual(["https://api.nearpay.localhost/v1/assets"]);
    expect(DEFAULT_BASE_URL).toBe("https://api.nearpay.money");
  });

  it("keeps SDK_VERSION equal to package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
      dependencies: Record<string, string>;
    };
    expect(SDK_VERSION).toBe(pkg.version);
    expect(Object.keys(pkg.dependencies)).toEqual(["@nearpay/spec"]);
  });
});

describe("typed errors", () => {
  const h = { "x-request-id": "req_hdr" };
  const env = (type: string, code = "c") => ({ error: { type, code, message: "m", doc_url: "https://d", param: "p" } });

  it("maps every catalogue error type to its subclass", () => {
    const expected: Record<string, typeof NearPayError> = {
      invalid_request_error: NearPayInvalidRequestError,
      authentication_error: NearPayAuthenticationError,
      permission_error: NearPayPermissionError,
      payment_error: NearPayPaymentError,
      idempotency_error: NearPayIdempotencyError,
      state_conflict: NearPayStateConflictError,
      rate_limit_error: NearPayRateLimitError,
      api_error: NearPayApiError,
      rail_unavailable: NearPayRailUnavailableError,
    };
    expect(Object.keys(expected).sort()).toEqual([...ERROR_TYPES].sort());
    for (const type of ERROR_TYPES) {
      const e = errorFromResponse(400, h, env(type));
      expect(e).toBeInstanceOf(expected[type]);
      expect(e).toBeInstanceOf(NearPayError);
      expect(e).toMatchObject({
        type,
        code: "c",
        param: "p",
        docUrl: "https://d",
        requestId: "req_hdr",
        statusCode: 400,
      });
      expect(e.name).toBe(expected[type]?.name);
    }
  });

  it("falls back to the base class for unknown types and prefers the envelope request id", () => {
    const e = errorFromResponse(418, h, { error: { ...env("teapot_error").error, request_id: "req_body" } });
    expect(e.constructor).toBe(NearPayError);
    expect(e.requestId).toBe("req_body");
    expect(e.raw).toBeDefined();
    expect(e.headers).toEqual(h);
  });

  it("classifies responses without an envelope by status", () => {
    expect(errorFromResponse(502, {}, "<html>")).toBeInstanceOf(NearPayApiError);
    expect(errorFromResponse(429, {}, undefined)).toBeInstanceOf(NearPayRateLimitError);
    const e = errorFromResponse(404, h, { error: "nope" });
    expect(e).toBeInstanceOf(NearPayInvalidRequestError);
    expect(e.code).toBeUndefined();
    expect(e.requestId).toBe("req_hdr");
    expect(errorFromResponse(400, {}, null)).toBeInstanceOf(NearPayInvalidRequestError);
  });

  it("defaults the base error fields", () => {
    const e = new NearPayError({ message: "x" });
    expect(e).toMatchObject({ type: "api_error", headers: {}, message: "x" });
    expect(new NearPayError({ message: "y", cause: new Error("z") }).cause).toBeInstanceOf(Error);
  });
});
