import { readFileSync } from "node:fs";
import { type AnyRoute, ERROR_TYPES, PUBLIC_ROUTES } from "@nearpay/spec";
import { describe, expect, expectTypeOf, it } from "vitest";
import { errorFromResponse } from "../../src/http/errors.js";
import { Transport } from "../../src/http/transport.js";
import {
  type AgentPayment,
  type CheckoutSession,
  DEFAULT_BASE_URL,
  methodAccess,
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
  restrictedKeyScope,
  SDK_VERSION,
  scopesFor,
  type WebhookDelivery,
} from "../../src/index.js";
import { bindRoute, pathParamNames, routesOf } from "../../src/resources/bind.js";

const keyCallable = (r: AnyRoute) => r.auth.some((a) => a === "secret_key" || a.startsWith("restricted_key:"));

describe("resource tree vs the spec route table", () => {
  const bound = routesOf(RESOURCES);

  it("binds every public route a secret or restricted key can call (Stages 1–3), exactly once", () => {
    const expected = PUBLIC_ROUTES.filter((r) => keyCallable(r))
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
        "paymentIntents.create",
        "paymentIntents.review",
        "refunds.create",
        "refunds.retrieve",
        "refunds.list",
        "refunds.prepare",
        "refunds.submitTx",
        "refunds.cancel",
        "paymentLinks.create",
        "paymentLinks.retrieve",
        "paymentLinks.list",
        "paymentLinks.update",
        "customers.create",
        "customers.retrieve",
        "customers.list",
        "customers.update",
        "customers.del",
        "webhookEndpoints.rotateSecret",
        "events.resend",
        "testHelpers.refunds.simulateDeposit",
        // stage 3 (spec 0.3.0)
        "products.create",
        "products.update",
        "prices.create",
        "prices.list",
        "taxRates.create",
        "taxRates.retrieve",
        "invoices.create",
        "invoices.finalize",
        "invoices.send",
        "invoices.void",
        "invoices.markUncollectible",
        "invoices.del",
        "invoices.pdf",
        "subscriptions.create",
        "subscriptions.list",
        "subscriptions.cancel",
        "events.stream",
        "x402.nearIntents.requirements",
        "x402.nearIntents.verify",
        "x402.nearIntents.settle",
        "testHelpers.checkoutSessions.pay",
      ]),
    );
  });

  it("leaves session-only and payer routes unbound (API keys, account, KYB, team, refund recipient override)", () => {
    const boundIds = new Set(bound.map((b) => b.route.id));
    const unbound = PUBLIC_ROUTES.filter((r) => !boundIds.has(r.id));
    for (const r of unbound) {
      expect(keyCallable(r), r.id).toBe(false);
    }
    for (const id of [
      "createApiKey",
      "listApiKeys",
      "getAccount",
      "getKyb",
      "updateRefundRecipient",
      "getPublicInvoice",
      "createPublicInvoiceSession",
      "getPublicInvoicePdf",
      "approveCliLogin",
      "createCliLogin",
    ]) {
      expect(boundIds.has(id), id).toBe(false);
    }
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

  it("types the spec 0.1.5 additions: deliveries, sequence, replayed", () => {
    const np = new NearPay("sk_test_types", { fetch: async () => new Response("{}") });
    type Deliveries = Awaited<ReturnType<typeof np.webhookEndpoints.listDeliveries>>;
    expectTypeOf<Deliveries["data"][number]>().toEqualTypeOf<WebhookDelivery>();
    expectTypeOf<WebhookDelivery["id"]>().toEqualTypeOf<`whd_${string}`>();
    expectTypeOf<WebhookDelivery["status"]>().toEqualTypeOf<"pending" | "succeeded" | "failed" | "abandoned">();
    expectTypeOf<WebhookDelivery["last_status_code"]>().toEqualTypeOf<number | null>();
    type DeliveriesQuery = NonNullable<Parameters<typeof np.webhookEndpoints.listDeliveries>[1]>;
    expectTypeOf<DeliveriesQuery["starting_after"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CheckoutSession["sequence"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AgentPayment["sequence"]>().toEqualTypeOf<number | undefined>();
    type Settled = Awaited<ReturnType<typeof np.x402.settle>>;
    expectTypeOf<Settled["replayed"]>().toEqualTypeOf<boolean | undefined>();
    // @ts-expect-error the endpoint id is required
    void (() => np.webhookEndpoints.listDeliveries());
  });

  it("keeps unknown open-enum values verbatim (tolerant parsing) and lists them on lastResponse", async () => {
    const body = {
      object: "list",
      data: [{ id: "whd_1", object: "webhook_delivery", status: "quarantined", attempts: 1 }],
      has_more: false,
      url: "/v1/webhook_endpoints/we_1/deliveries",
    };
    const seen: string[] = [];
    const np = new NearPay("sk_test_abc", {
      baseUrl: "https://api.nearpay.localhost",
      onValidationIssue: () => {},
      fetch: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    const page = await np.webhookEndpoints.listDeliveries("we_1", { limit: 5 });
    expect(page).toEqual(body);
    expect(page.data[0]?.status as string).toBe("quarantined");
    expect(page.lastResponse?.validationIssues.length).toBeGreaterThan(0); // the minimal body lacks required fields
    expect(seen).toEqual(["https://api.nearpay.localhost/v1/webhook_endpoints/we_1/deliveries?limit=5"]);
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

describe("Stage 2 method types", () => {
  it("types list queries: grouped ranges, metadata filters, flat keys; list results are ListPromises", () => {
    const np = new NearPay("sk_test_types", { fetch: async () => new Response("{}") });
    type Q = NonNullable<Parameters<typeof np.paymentIntents.list>[0]>;
    expectTypeOf<Q["metadata"]>().toEqualTypeOf<Readonly<Record<string, string>> | undefined>();
    expectTypeOf<NonNullable<Q["amount"]>["gte"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NonNullable<Q["created"]>["gte"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Q["created[gte]"]>().toEqualTypeOf<number | undefined>();
    type RQ = NonNullable<Parameters<typeof np.refunds.list>[0]>;
    // @ts-expect-error metadata filters exist only where the spec declares them
    void ((q: RQ) => q.metadata);
    const listed = np.refunds.list();
    listed.catch(() => {});
    expectTypeOf(listed.autoPagingToArray).returns.resolves.items.toHaveProperty("next_action");
    type Created = Awaited<ReturnType<typeof np.paymentIntents.create>>;
    expectTypeOf<Created["client_secret"]>().toBeString();
    type Body = Parameters<typeof np.refunds.submitTx>[1];
    void ((b: Body) => b);
    void (() => np.refunds.submitTx("re_x", { tx_hash: "0x1234567890" }));
    // @ts-expect-error submit_tx takes a tx hash or a signed intent
    void (() => np.refunds.submitTx("re_x", { hash: "0x" }));
    void (() => np.webhookEndpoints.rotateSecret("we_x"));
    void (() => np.events.resend("evt_x"));
    void (() => np.customers.del("cus_x"));
    void (() => np.testHelpers.refunds.simulateDeposit("re_x"));
    expectTypeOf(np.refunds.signers.signAndSubmit).toBeFunction();
  });
});

describe("Stage 3 method types (spec 0.3.0)", () => {
  it("types billing methods, the PDF bytes, the event stream and the test helper", () => {
    const np = new NearPay("sk_test_types", { fetch: async () => new Response("{}") });
    type InvoiceCreate = Parameters<typeof np.invoices.create>[0];
    void ((b: InvoiceCreate) => b.customer);
    void (() => np.invoices.create({ customer: "cus_x", lines: [{ price: "price_x", quantity: 2 }] }));
    // @ts-expect-error customer is required
    void (() => np.invoices.create({ lines: [] }));
    type Inv = Awaited<ReturnType<typeof np.invoices.finalize>>;
    expectTypeOf<Inv["hosted_invoice_url"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Inv["total"]>().toEqualTypeOf<string | number>();
    expectTypeOf(np.invoices.pdf).returns.resolves.toMatchTypeOf<Uint8Array>();
    expectTypeOf<Awaited<ReturnType<typeof np.invoices.pdf>>["filename"]>().toEqualTypeOf<string | undefined>();
    type SQ = NonNullable<Parameters<typeof np.subscriptions.list>[0]>;
    void ((q: SQ) => q.customer);
    void (() => np.subscriptions.cancel("sub_x", { at_period_end: true }));
    void (() => np.taxRates.create({ display_name: "VAT", percentage: "19", inclusive: false }));
    // @ts-expect-error percentages are decimal strings (no floats)
    void (() => np.taxRates.create({ display_name: "VAT", percentage: 19, inclusive: false }));
    const stream = np.events.stream({ types: ["invoice.paid"] }, { reconnect: false });
    stream.close();
    void (async () => {
      for await (const e of stream) {
        if (e.type === "invoice.paid") expectTypeOf(e.data.object.amount_paid).toEqualTypeOf<string | number>();
        if (e.type === "customer.subscription.deleted") expectTypeOf(e.data.object.status).toBeString();
      }
    });
    expectTypeOf(stream.lastEventId).toEqualTypeOf<string | undefined>();
    type Paid = Awaited<ReturnType<typeof np.testHelpers.checkoutSessions.pay>>;
    expectTypeOf<Paid["payment_intent"]>().toBeString();
    void (() => np.x402.nearIntents.requirements);
  });
});

describe("restricted keys", () => {
  it("knows the scope of every method", () => {
    expect(restrictedKeyScope("refunds.create")).toBe("refunds.write");
    expect(restrictedKeyScope("paymentIntents.list")).toBe("payment_intents.read");
    expect(restrictedKeyScope("testHelpers.paymentAttempts.advance")).toBe("checkout_sessions.write");
    expect(restrictedKeyScope("invoices.pdf")).toBe("invoices.read");
    expect(restrictedKeyScope("events.stream")).toBe("events.read");
    expect(restrictedKeyScope("subscriptions.cancel")).toBe("subscriptions.write");
    expect(restrictedKeyScope("taxRates.create")).toBe("products.write");
    expect(restrictedKeyScope("assets.list")).toBeNull();
    expect(() => restrictedKeyScope("nope.nope" as "assets.list")).toThrow(/unknown/);
    expect(scopesFor(["refunds.create", "refunds.retrieve", "refunds.submitTx", "assets.list"])).toEqual([
      "refunds.read",
      "refunds.write",
    ]);
    // spec 0.3.0: every key-callable route admits a restricted key (the sandbox helpers too)
    expect(scopesFor(["testHelpers.refunds.simulateDeposit", "testHelpers.checkoutSessions.pay"])).toEqual([
      "checkout_sessions.write",
      "refunds.write",
    ]);
    expect(scopesFor(["invoices.create", "invoices.finalize", "invoices.send", "invoices.pdf"])).toEqual([
      "invoices.read",
      "invoices.write",
    ]);
    expect(methodAccess().get("webhookSigningKeys.list")).toEqual({ scope: null, anonymous: true });
    expect(methodAccess().size).toBe(routesOf(RESOURCES).length);
  });
});
