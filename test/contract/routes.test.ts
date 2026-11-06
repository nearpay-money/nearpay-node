/**
 * Contract test: every SDK method is called through a minimal gateway into the spec-driven mock of the
 * owning service (`mockPeer`). The mock validates path, query and body strictly against the route,
 * authorizes the secret-key principal from the route's `auth`, and validates every response against the
 * route's response schema; so a passing call proves the SDK's request matches `@nearpay/spec` 0.1.4.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  API_VERSION,
  advancePaymentAttempt,
  cancelPaymentIntent,
  createCheckoutSession,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  Event,
  expireCheckoutSession,
  getAgentPayment,
  getCheckoutSession,
  getEvent,
  getPaymentIntent,
  getSettlementDestination,
  getWebhookEndpoint,
  listAgentPayments,
  listAssets,
  listBalanceTransactions,
  listCheckoutSessions,
  listEvents,
  listPaymentIntents,
  listSettlementDestinations,
  listWebhookEndpoints,
  listWebhookSigningKeys,
  MultiPayload,
  PaymentRequired,
  SettleResponse,
  SupportedResponse,
  testWebhookEndpoint,
  updateWebhookEndpoint,
  VerifyResponse,
  WebhookEndpoint,
  x402Requirements,
  x402Settle,
  x402Supported,
  x402Verify,
} from "@nearpay/spec";
import {
  agentPayment,
  balanceTransaction,
  checkoutSession,
  mockError,
  paymentIntent,
  settlementDestination,
  USDC_NEAR,
} from "@nearpay-internal/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NearPay, NearPayInvalidRequestError, NearPayStateConflictError } from "../../src/index.js";
import { routesOf } from "../../src/resources/bind.js";
import { RESOURCES } from "../../src/resources/routes.js";
import { ACCOUNT, type Gateway, startGateway } from "../support/gateway.js";

const require = createRequire(import.meta.url);
const vectors = JSON.parse(
  readFileSync(require.resolve("@nearpay/spec/test-vectors/intents-payloads.json"), "utf8"),
) as { binding: string; nep413: { multipayload: unknown } };

const KEY = "sk_test_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
const now = () => Math.floor(Date.now() / 1000);
const list = <T>(url: string, data: T[]) => ({ object: "list" as const, data, has_more: false, url });

const endpoint = WebhookEndpoint.parse({
  id: "we_01jbz9k3m4n5p6q7r8s9t0v1w2",
  object: "webhook_endpoint",
  created: now(),
  livemode: false,
  url: "https://merchant.example/webhooks",
  enabled_events: ["payment_intent.succeeded"],
  api_version: API_VERSION,
  description: null,
  status: "enabled",
  disabled_reason: null,
});
const pingEvent = Event.parse({
  id: "evt_01jbz9k3m4n5p6q7r8s9t0v1w2",
  object: "event",
  type: "ping",
  api_version: API_VERSION,
  created: now(),
  livemode: false,
  data: { object: { object: "ping", webhook_endpoint: endpoint.id } },
  request: { id: null, idempotency_key: null },
});
const requirements = {
  scheme: "exact",
  network: "near:mainnet",
  amount: "2000000",
  asset: USDC_NEAR,
  payTo: "merchant.near",
  maxTimeoutSeconds: 120,
  extra: {
    assetTransferMethod: "intents-transfer",
    paymentFlow: "authorization",
    fee: { to: "treasury.nearpay.near", amount: "6000" },
    binding: vectors.binding,
    verifyingContract: "intents.near",
  },
} as const;
const paymentRequired = PaymentRequired.parse({
  x402Version: 2,
  resource: { url: "https://merchant.example/premium" },
  accepts: [requirements],
});
const verifyRequest = {
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    accepted: requirements,
    payload: { signed: MultiPayload.parse(vectors.nep413.multipayload) },
  },
  paymentRequirements: requirements,
} as const;

let gw: Gateway;
let np: NearPay;

beforeAll(async () => {
  gw = await startGateway(["payments", "webhooks", "agentpay", "identity", "rails"]);
  np = new NearPay(KEY, { baseUrl: gw.url, maxRetries: 0 });
});
afterAll(() => gw?.stop());
beforeEach(() => {
  for (const p of Object.values(gw.peers)) p.reset();
});

describe("payments", () => {
  it("creates a checkout session with an automatic Idempotency-Key", async () => {
    const payments = gw.peer("payments");
    payments.on(createCheckoutSession, async (ctx) =>
      checkoutSession({ amount: ctx.body.amount, currency: ctx.body.currency, success_url: ctx.body.success_url }),
    );
    const s = await np.checkout.sessions.create({
      amount: 200,
      currency: "usd",
      success_url: "https://merchant.example/thanks",
      description: "Premium plan",
      metadata: { order_id: "42" },
    });
    expect(s.object).toBe("checkout_session");
    expect(s.amount).toBe(200);
    const call = payments.callsTo(createCheckoutSession)[0];
    expect(call?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.principal).toMatchObject({ ptype: "secret_key", acct: ACCOUNT, lm: false });
    expect(call?.body).toMatchObject({ amount: 200, ui_mode: "hosted", metadata: { order_id: "42" } });
  });

  it("creates an asset-priced session and rejects an invalid one with a typed error", async () => {
    gw.peer("payments").on(createCheckoutSession, async () => checkoutSession());
    await np.checkout.sessions.create({
      amount: "2000000",
      currency: "asset",
      asset_id: USDC_NEAR,
      success_url: "https://merchant.example/ok",
    });
    const e = await np.checkout.sessions
      .create({ amount: "2000000", currency: "usd", success_url: "https://merchant.example/ok" })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayInvalidRequestError);
    expect((e as NearPayInvalidRequestError).code).toBe("invalid_request");
    expect((e as NearPayInvalidRequestError).requestId).toMatch(/^req_/);
  });

  it("retrieves (with expand[]) and lists sessions with created filters", async () => {
    const payments = gw.peer("payments");
    const s = checkoutSession();
    payments.on(getCheckoutSession, async () => s);
    payments.on(listCheckoutSessions, async () => list("/v1/checkout/sessions", [s]));
    expect((await np.checkout.sessions.retrieve(s.id, { expand: ["payment_intent"] })).id).toBe(s.id);
    const page = await np.checkout.sessions.list({ limit: 2, "created[gte]": 1, status: "open" });
    expect(page.data).toHaveLength(1);
    expect(payments.callsTo(getCheckoutSession)[0]?.query).toEqual({ expand: ["payment_intent"] });
    expect(payments.callsTo(listCheckoutSessions)[0]?.query).toMatchObject({ limit: 2, "created[gte]": 1 });
  });

  it("expires a session and maps state conflicts", async () => {
    const payments = gw.peer("payments");
    payments.on(expireCheckoutSession, async () => mockError("attempt_in_flight"));
    const e = await np.checkout.sessions.expire(checkoutSession().id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayStateConflictError);
    expect((e as NearPayStateConflictError).code).toBe("attempt_in_flight");
    payments.on(expireCheckoutSession, async () => checkoutSession({ status: "expired" }));
    expect((await np.checkout.sessions.expire(checkoutSession().id)).status).toBe("expired");
  });

  it("retrieves, lists and cancels payment intents", async () => {
    const payments = gw.peer("payments");
    const pi = paymentIntent();
    payments.on(getPaymentIntent, async () => pi);
    payments.on(listPaymentIntents, async () => list("/v1/payment_intents", [pi]));
    payments.on(cancelPaymentIntent, async (ctx) =>
      paymentIntent({ status: "canceled", cancellation_reason: ctx.body.cancellation_reason ?? null }),
    );
    expect((await np.paymentIntents.retrieve(pi.id)).id).toBe(pi.id);
    expect((await np.paymentIntents.list({ status: "succeeded" })).data[0]?.id).toBe(pi.id);
    const canceled = await np.paymentIntents.cancel(pi.id, { cancellation_reason: "customer left" });
    expect(canceled.status).toBe("canceled");
    expect(canceled.cancellation_reason).toBe("customer left");
  });

  it("lists balance transactions and advances a test attempt", async () => {
    const payments = gw.peer("payments");
    payments.on(listBalanceTransactions, async () => list("/v1/balance_transactions", [balanceTransaction()]));
    payments.on(advancePaymentAttempt, async () => undefined);
    expect((await np.balanceTransactions.list({ type: "payment" })).data).toHaveLength(1);
    await expect(
      np.testHelpers.paymentAttempts.advance("pa_01jbz9k3m4n5p6q7r8s9t0v1w2", { to: "success" }),
    ).resolves.toBeUndefined();
    expect(payments.callsTo(advancePaymentAttempt)[0]?.params).toEqual({ attempt: "pa_01jbz9k3m4n5p6q7r8s9t0v1w2" });
  });
});

describe("webhooks and events", () => {
  it("creates, reads, updates, tests and deletes endpoints", async () => {
    const w = gw.peer("webhooks");
    w.on(createWebhookEndpoint, async () => ({ ...endpoint, secret: `whsec_${"a".repeat(32)}` }));
    w.on(getWebhookEndpoint, async () => endpoint);
    w.on(listWebhookEndpoints, async () => list("/v1/webhook_endpoints", [endpoint]));
    w.on(updateWebhookEndpoint, async () => ({
      ...endpoint,
      status: "disabled" as const,
      disabled_reason: "merchant" as const,
    }));
    w.on(testWebhookEndpoint, async () => pingEvent);
    w.on(deleteWebhookEndpoint, async () => undefined);
    const created = await np.webhookEndpoints.create({
      url: "https://merchant.example/webhooks",
      enabled_events: ["payment_intent.succeeded", "agent_payment.settled"],
    });
    expect(created.secret).toMatch(/^whsec_/);
    expect((await np.webhookEndpoints.retrieve(endpoint.id)).url).toBe(endpoint.url);
    expect((await np.webhookEndpoints.list()).data).toHaveLength(1);
    expect((await np.webhookEndpoints.update(endpoint.id, { disabled: true })).status).toBe("disabled");
    expect((await np.webhookEndpoints.test(endpoint.id)).type).toBe("ping");
    await expect(np.webhookEndpoints.del(endpoint.id)).resolves.toBeUndefined();
    expect(w.callsTo(updateWebhookEndpoint)[0]?.idempotencyKey).toBeDefined();
  });

  it("lists and retrieves events and fetches the signing keys anonymously", async () => {
    const w = gw.peer("webhooks");
    w.on(listEvents, async () => list("/v1/events", [pingEvent]));
    w.on(getEvent, async () => pingEvent);
    w.on(listWebhookSigningKeys, async () =>
      listWebhookSigningKeys.response.parse({
        keys: [
          {
            kty: "OKP",
            crv: "Ed25519",
            x: "EWVsckKqSzTdxJNeXx-lDnI_N-erV3I_04fh1_5YUuk",
            kid: "wh-1",
            alg: "EdDSA",
            use: "sig",
          },
        ],
      }),
    );
    expect((await np.events.list({ type: "ping", "created[lte]": now() + 10 })).data[0]?.id).toBe(pingEvent.id);
    expect((await np.events.retrieve(pingEvent.id)).id).toBe(pingEvent.id);
    expect((await np.webhookSigningKeys.list()).keys[0]?.kid).toBe("wh-1");
    expect(w.callsTo(listWebhookSigningKeys)[0]?.principal).toBeNull();
  });
});

describe("agent payments and x402", () => {
  it("lists and retrieves agent payments", async () => {
    const a = gw.peer("agentpay");
    const ap = agentPayment();
    a.on(listAgentPayments, async () => list("/v1/agent_payments", [ap]));
    a.on(getAgentPayment, async () => ap);
    expect((await np.agentPayments.list({ kind: "x402" })).data[0]?.id).toBe(ap.id);
    expect((await np.agentPayments.retrieve(ap.id)).kind).toBe(ap.kind);
  });

  it("calls the facilitator: supported, requirements, verify, settle", async () => {
    const a = gw.peer("agentpay");
    a.on(x402Supported, async () =>
      SupportedResponse.parse({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "near:mainnet",
            extra: { assetTransferMethod: "intents-transfer" },
          },
        ],
        extensions: [],
        signers: { "near:*": ["relayer.nearpay.near"] },
      }),
    );
    a.on(x402Requirements, async () => paymentRequired);
    a.on(x402Verify, async () => VerifyResponse.parse({ isValid: true, payer: "agent.near" }));
    a.on(x402Settle, async () =>
      SettleResponse.parse({ success: true, transaction: "8xQ3mTn2tx", network: "near:mainnet", amount: "2000000" }),
    );
    expect((await np.x402.supported()).kinds).toHaveLength(1);
    const req = await np.x402.requirements({
      resource: { url: "https://merchant.example/premium" },
      amount: "2000000",
    });
    expect(req.accepts[0]?.payTo).toBe("merchant.near");
    expect((await np.x402.verify(verifyRequest)).isValid).toBe(true);
    expect((await np.x402.settle(verifyRequest)).success).toBe(true);
    expect(a.callsTo(x402Requirements)[0]?.body).toMatchObject({ max_timeout_s: 120 });
  });
});

describe("destinations and assets", () => {
  it("reads settlement destinations and the asset registry", async () => {
    const id = gw.peer("identity");
    const sd = settlementDestination();
    id.on(listSettlementDestinations, async () => list("/v1/settlement_destinations", [sd]));
    id.on(getSettlementDestination, async () => sd);
    gw.peer("rails").on(listAssets, async () => ({
      object: "list" as const,
      data: [
        {
          asset_id: USDC_NEAR,
          object: "asset" as const,
          chain: "near:mainnet",
          symbol: "USDC",
          decimals: 6,
          family: "USDC",
          is_usd_stable: true,
        },
      ],
      has_more: false as const,
      url: "/v1/assets" as const,
    }));
    expect((await np.settlementDestinations.list({ status: "active" })).data[0]?.id).toBe(sd.id);
    expect((await np.settlementDestinations.retrieve(sd.id)).fingerprint).toBe(sd.fingerprint);
    expect((await np.assets.list()).data[0]?.symbol).toBe("USDC");
  });
});

it("covers every bound route in the cases above", () => {
  const ids = routesOf(RESOURCES).map((b) => b.route.id);
  const covered = [
    createCheckoutSession,
    getCheckoutSession,
    listCheckoutSessions,
    expireCheckoutSession,
    getPaymentIntent,
    listPaymentIntents,
    cancelPaymentIntent,
    listBalanceTransactions,
    advancePaymentAttempt,
    createWebhookEndpoint,
    getWebhookEndpoint,
    listWebhookEndpoints,
    updateWebhookEndpoint,
    testWebhookEndpoint,
    deleteWebhookEndpoint,
    listEvents,
    getEvent,
    listWebhookSigningKeys,
    listAgentPayments,
    getAgentPayment,
    x402Supported,
    x402Requirements,
    x402Verify,
    x402Settle,
    listSettlementDestinations,
    getSettlementDestination,
    listAssets,
  ].map((r) => r.id);
  expect(new Set(ids)).toEqual(new Set(covered));
});
