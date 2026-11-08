/**
 * Contract test: every SDK method is called through a minimal gateway into the spec-driven mock of the
 * owning service (`mockPeer`). The mock validates path, query and body strictly against the route,
 * authorizes the secret-key principal from the route's `auth`, and validates every response against the
 * route's response schema; so a passing call proves the SDK's request matches `@nearpay/spec` 0.3.0.
 * Stage 3 adds the billing service, the events stream (frames written through the kit's `ctx.sse()`)
 * and the invoice PDF (the kit has no binary responses yet, so the handler writes the bytes itself).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  API_VERSION,
  advancePaymentAttempt,
  cancelPaymentIntent,
  cancelRefund,
  cancelSubscription,
  createCheckoutSession,
  createCustomer,
  createInvoice,
  createPaymentIntent,
  createPaymentLink,
  createPrice,
  createProduct,
  createRefund,
  createSubscription,
  createTaxRate,
  createWebhookEndpoint,
  deleteCustomer,
  deleteInvoice,
  deleteWebhookEndpoint,
  Event,
  expireCheckoutSession,
  finalizeInvoice,
  getAgentPayment,
  getCheckoutSession,
  getCustomer,
  getEvent,
  getInvoice,
  getInvoicePdf,
  getPaymentIntent,
  getPaymentLink,
  getPrice,
  getProduct,
  getRefund,
  getSettlementDestination,
  getSubscription,
  getTaxRate,
  getWebhookEndpoint,
  listAgentPayments,
  listAssets,
  listBalanceTransactions,
  listCheckoutSessions,
  listCustomers,
  listEvents,
  listInvoices,
  listPaymentIntents,
  listPaymentLinks,
  listPrices,
  listProducts,
  listRefunds,
  listSettlementDestinations,
  listSubscriptions,
  listTaxRates,
  listWebhookEndpointDeliveries,
  listWebhookEndpoints,
  listWebhookSigningKeys,
  MultiPayload,
  markInvoiceUncollectible,
  NearIntentsSettleResponse,
  NearIntentsVerifyResponse,
  PaymentRequired,
  payCheckoutSessionTestHelper,
  prepareRefund,
  resendEvent,
  reviewPaymentIntent,
  rotateWebhookEndpointSecret,
  SettleResponse,
  SupportedResponse,
  sendInvoice,
  simulateRefundDeposit,
  streamEvents,
  submitRefundTx,
  testWebhookEndpoint,
  updateCustomer,
  updateInvoice,
  updatePaymentLink,
  updatePrice,
  updateProduct,
  updateSubscription,
  updateTaxRate,
  updateWebhookEndpoint,
  VerifyResponse,
  voidInvoice,
  WebhookDelivery,
  WebhookEndpoint,
  X402PaymentRequiredAny,
  x402NearIntentsRequirements,
  x402NearIntentsSettle,
  x402NearIntentsVerify,
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
import {
  createdPaymentIntent,
  customer,
  deletedCustomer,
  deletedInvoice,
  event,
  eventResend,
  ids,
  invoice,
  paymentLink,
  price,
  product,
  refund,
  signIntentAction,
  streamReady,
  subscription,
  taxRate,
  testHelperPayment,
  webhookEndpoint,
} from "../support/fixtures.js";
import { ACCOUNT, type Gateway, startGateway } from "../support/gateway.js";

const require = createRequire(import.meta.url);
const vectors = JSON.parse(
  readFileSync(require.resolve("@nearpay/spec/test-vectors/intents-payloads.json"), "utf8"),
) as { binding: string; nep413: { multipayload: unknown } };
const niVectors = JSON.parse(
  readFileSync(require.resolve("@nearpay/spec/test-vectors/x402-near-intents.json"), "utf8"),
) as { headers: Record<string, { accepts?: unknown[] } & Record<string, unknown>> };

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
const delivery = WebhookDelivery.parse({
  id: "whd_01jbz9k3m4n5p6q7r8s9t0v1w2",
  object: "webhook_delivery",
  created: now(),
  livemode: false,
  webhook_endpoint: endpoint.id,
  event: "evt_01jbz9k3m4n5p6q7r8s9t0v1w3",
  event_type: "payment_intent.succeeded",
  status: "failed",
  attempts: 2,
  last_status_code: 500,
  last_error: "non-2xx response",
  next_attempt_at: now() + 60,
  succeeded_at: null,
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
  gw = await startGateway(["payments", "webhooks", "agentpay", "identity", "rails", "billing"]);
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
    const s = { ...checkoutSession(), sequence: 4 };
    payments.on(getCheckoutSession, async () => s);
    payments.on(listCheckoutSessions, async () => list("/v1/checkout/sessions", [s]));
    expect(await np.checkout.sessions.retrieve(s.id, { expand: ["payment_intent"] })).toMatchObject({
      id: s.id,
      sequence: 4,
    });
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

  it("lists an endpoint's deliveries with cursor pagination (spec 0.1.5)", async () => {
    const w = gw.peer("webhooks");
    w.on(listWebhookEndpointDeliveries, async () => ({
      ...list(`/v1/webhook_endpoints/${endpoint.id}/deliveries`, [delivery]),
      has_more: true,
    }));
    const page = await np.webhookEndpoints.listDeliveries(endpoint.id, { limit: 1, starting_after: "whd_x" });
    expect(page.has_more).toBe(true);
    expect(page.data[0]).toMatchObject({ id: delivery.id, status: "failed", attempts: 2, last_status_code: 500 });
    const call = w.callsTo(listWebhookEndpointDeliveries)[0];
    expect(call?.params).toEqual({ id: endpoint.id });
    expect(call?.query).toMatchObject({ limit: 1, starting_after: "whd_x" });
    expect(call?.idempotencyKey).toBeUndefined();
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
    const ap = { ...agentPayment(), sequence: 2 };
    a.on(listAgentPayments, async () => list("/v1/agent_payments", [ap]));
    a.on(getAgentPayment, async () => ap);
    expect((await np.agentPayments.list({ kind: "x402" })).data[0]?.id).toBe(ap.id);
    expect(await np.agentPayments.retrieve(ap.id)).toMatchObject({ kind: ap.kind, sequence: 2 });
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
      SettleResponse.parse({
        success: true,
        transaction: "8xQ3mTn2tx",
        network: "near:mainnet",
        amount: "2000000",
        replayed: true,
      }),
    );
    expect((await np.x402.supported()).kinds).toHaveLength(1);
    const req = await np.x402.requirements({
      resource: { url: "https://merchant.example/premium" },
      amount: "2000000",
    });
    expect(req.accepts[0]?.payTo).toBe("merchant.near");
    expect((await np.x402.verify(verifyRequest)).isValid).toBe(true);
    expect(await np.x402.settle(verifyRequest)).toMatchObject({ success: true, replayed: true });
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

describe("stage 2 (spec 0.2.0)", () => {
  it("payment intents: create (headless) with ADR-0018 list filters and review", async () => {
    const p = gw.peer("payments");
    p.on(createPaymentIntent, async () => createdPaymentIntent());
    p.on(reviewPaymentIntent, async () => paymentIntent({ status: "requires_payment" }));
    p.on(listPaymentIntents, async () => list("/v1/payment_intents", [paymentIntent()]));
    expect(
      (await np.paymentIntents.create({ amount: 4999, currency: "usd", return_url: "https://m.example/r" }))
        .client_secret,
    ).toMatch(/_secret_/);
    await np.paymentIntents.review(ids.pi, { decision: "reject", reason: "short" });
    await np.paymentIntents.list({
      amount: { gte: "100" },
      created: { gte: 1 },
      customer: ids.cus,
      metadata: { order_id: "42" },
    });
    expect(p.callsTo(listPaymentIntents)[0]?.query).toMatchObject({ "amount[gte]": "100", "metadata[order_id]": "42" });
  });

  it("refunds: create, retrieve, list, prepare, submit_tx, cancel, simulate deposit", async () => {
    const p = gw.peer("payments");
    const r = refund({ next_action: signIntentAction({ signerId: "merchant.near" }) });
    for (const route of [createRefund, getRefund, prepareRefund, submitRefundTx, cancelRefund])
      p.on(route, async () => r);
    p.on(listRefunds, async () => list("/v1/refunds", [r]));
    p.on(simulateRefundDeposit, async () => undefined);
    await np.refunds.create({ payment_intent: ids.pi, amount: "2000000" });
    await np.refunds.retrieve(r.id);
    await np.refunds.list({ status: "requires_action" });
    await np.refunds.prepare(r.id);
    await np.refunds.submitTx(r.id, { signed_intent: MultiPayload.parse(vectors.nep413.multipayload) });
    await np.refunds.cancel(r.id);
    await np.testHelpers.refunds.simulateDeposit(r.id);
    expect(p.callsTo(submitRefundTx)[0]?.idempotencyKey).toBeDefined();
  });

  it("payment links and customers", async () => {
    const p = gw.peer("payments");
    p.on(createPaymentLink, async () => paymentLink());
    p.on(getPaymentLink, async () => paymentLink());
    p.on(listPaymentLinks, async () => list("/v1/payment_links", [paymentLink()]));
    p.on(updatePaymentLink, async () => paymentLink({ active: false }));
    p.on(createCustomer, async () => customer());
    p.on(getCustomer, async () => customer());
    p.on(listCustomers, async () => list("/v1/customers", [customer()]));
    p.on(updateCustomer, async () => customer());
    p.on(deleteCustomer, async () => deletedCustomer());
    await np.paymentLinks.create({ amount: 2500, currency: "usd", description: "T-shirt" });
    await np.paymentLinks.retrieve(ids.plink);
    await np.paymentLinks.list({ active: true });
    await np.paymentLinks.update(ids.plink, { active: false });
    await np.customers.create({ email: "ada@example.com" });
    await np.customers.retrieve(ids.cus);
    await np.customers.list({ email: "ada@example.com" });
    await np.customers.update(ids.cus, { name: "Ada" });
    expect((await np.customers.del(ids.cus)).deleted).toBe(true);
  });

  it("webhooks: rotate secret and resend", async () => {
    const w = gw.peer("webhooks");
    w.on(rotateWebhookEndpointSecret, async () => ({
      ...webhookEndpoint(),
      secret: `whsec_${"c".repeat(32)}`,
      previous_secret_expires_at: now() + 60,
    }));
    w.on(resendEvent, async () => eventResend());
    expect((await np.webhookEndpoints.rotateSecret(ids.we, { expire_previous_in_seconds: 60 })).secret).toMatch(
      /^whsec_/,
    );
    expect((await np.events.resend(ids.evt)).deliveries).toHaveLength(1);
  });
});

describe("stage 3 (spec 0.3.0)", () => {
  it("billing catalogue: products, prices, tax rates", async () => {
    const b = gw.peer("billing");
    b.on(createProduct, async () => product());
    b.on(getProduct, async () => product());
    b.on(listProducts, async () => list("/v1/products", [product()]));
    b.on(updateProduct, async () => product({ active: false }));
    b.on(createPrice, async () => price());
    b.on(getPrice, async () => price());
    b.on(listPrices, async () => list("/v1/prices", [price()]));
    b.on(updatePrice, async () => price());
    b.on(createTaxRate, async () => taxRate());
    b.on(getTaxRate, async () => taxRate());
    b.on(listTaxRates, async () => list("/v1/tax_rates", [taxRate()]));
    b.on(updateTaxRate, async () => taxRate());
    await np.products.create({ name: "Pro plan", metadata: { sku: "pro" } });
    await np.products.retrieve(ids.prod);
    await np.products.list({ active: false, limit: 5 });
    await np.products.update(ids.prod, { active: false });
    await np.prices.create({ product: ids.prod, unit_amount: "5000000", currency: "asset", asset_id: USDC_NEAR });
    await np.prices.retrieve(ids.price);
    await np.prices.list({ active: true });
    await np.prices.update(ids.price, { active: false });
    await np.taxRates.create({
      display_name: "Sales tax",
      percentage: "8.875",
      inclusive: false,
      jurisdiction: "US-NY",
    });
    await np.taxRates.retrieve(ids.txr);
    await np.taxRates.list({ inclusive: false });
    await np.taxRates.update(ids.txr, { active: false });
    expect(b.callsTo(createPrice)[0]?.principal).toMatchObject({ ptype: "secret_key", acct: ACCOUNT });
    expect(b.callsTo(listProducts)[0]?.query).toMatchObject({ active: false, limit: 5 });
  });

  it("invoices incl. lifecycle and the PDF bytes", async () => {
    const b = gw.peer("billing");
    const open = invoice({ status: "open" });
    b.on(createInvoice, async () => invoice());
    b.on(getInvoice, async () => open);
    b.on(listInvoices, async () => list("/v1/invoices", [open]));
    b.on(updateInvoice, async () => invoice());
    b.on(deleteInvoice, async () => deletedInvoice());
    b.on(finalizeInvoice, async () => open);
    b.on(sendInvoice, async () => open);
    b.on(voidInvoice, async () => invoice({ status: "void" }));
    b.on(markInvoiceUncollectible, async () => invoice({ status: "uncollectible", uncollectible_reason: "merchant" }));
    const pdf = Buffer.from("%PDF-1.7\n%%EOF\n");
    b.on(getInvoicePdf, async (ctx) => {
      ctx.reply.hijack();
      ctx.reply.raw.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="INV-00042.pdf"',
        "cache-control": "private, no-store",
      });
      ctx.reply.raw.end(pdf);
    });
    const draft = await np.invoices.create({
      customer: ids.cus,
      lines: [{ price: ids.price }],
      due_date: now() + 86_400,
      reminder_days: [0, 7],
    });
    await np.invoices.update(draft.id, { lines: [{ unit_amount: 1000, description: "Consulting", quantity: 3 }] });
    await np.invoices.finalize(draft.id);
    await np.invoices.send(draft.id);
    await np.invoices.retrieve(draft.id);
    await np.invoices.list({ status: "open", "due_date[gte]": now() });
    await np.invoices.void(draft.id);
    await np.invoices.markUncollectible(draft.id);
    await np.invoices.del(draft.id);
    const bytes = await np.invoices.pdf(draft.id);
    expect(Buffer.from(bytes).equals(pdf)).toBe(true);
    expect(bytes.filename).toBe("INV-00042.pdf");
    expect(b.callsTo(finalizeInvoice)[0]?.idempotencyKey).toBeDefined();
    expect(b.callsTo(getInvoicePdf)[0]?.params).toEqual({ id: draft.id });
  });

  it("subscriptions", async () => {
    const b = gw.peer("billing");
    b.on(createSubscription, async () => subscription());
    b.on(getSubscription, async () => subscription());
    b.on(listSubscriptions, async () => list("/v1/subscriptions", [subscription()]));
    b.on(updateSubscription, async () => subscription());
    b.on(cancelSubscription, async () => subscription({ status: "canceled", cancellation_reason: "requested" }));
    await np.subscriptions.create({ customer: ids.cus, items: [{ price: ids.price }], days_until_due: 7 });
    await np.subscriptions.retrieve(ids.sub);
    await np.subscriptions.list({ status: "past_due" });
    await np.subscriptions.update(ids.sub, { items: [{ price: ids.price, quantity: 3 }] });
    expect((await np.subscriptions.cancel(ids.sub)).status).toBe("canceled");
    expect(b.callsTo(cancelSubscription)[0]?.body).toEqual({});
  });

  it("events stream through the kit's SSE writer, resuming with Last-Event-ID", async () => {
    const w = gw.peer("webhooks");
    const e1 = event("invoice.finalized", invoice({ status: "open", hosted_invoice_url: null }), {
      id: "evt_01jbz9k3m4n5p6q7r8s9t0v1w5",
    });
    w.on(streamEvents, async (ctx) => {
      const s = ctx.sse();
      s.send("ready", streamReady({ resumed_after: ctx.headers["last-event-id"] ?? null }));
      s.send("event", e1, e1.id);
      s.close();
    });
    const stream = np.events.stream({ types: ["invoice.finalized"], starting_after: ids.evt }, { reconnect: false });
    const got: string[] = [];
    for await (const e of stream) got.push(String(e.id)); // TypedEvent envelope keys are `unknown` until spec CR (see CHANGELOG)
    expect(got).toEqual([e1.id]);
    expect(stream.ready?.resumed_after).toBe(ids.evt);
    const call = w.callsTo(streamEvents)[0];
    expect(call?.query).toMatchObject({ types: "invoice.finalized" });
    expect(call?.headers["last-event-id"]).toBe(ids.evt);
  });

  it("cross-chain x402 and the checkout test helper", async () => {
    const a = gw.peer("agentpay");
    const h = niVectors.headers;
    const unquoted = (h.payment_required_unquoted?.accepts ?? [])[0];
    a.on(x402NearIntentsRequirements, async () => X402PaymentRequiredAny.parse(h.payment_required_unquoted));
    a.on(x402NearIntentsVerify, async () => NearIntentsVerifyResponse.parse(h.verify_response_quote));
    a.on(x402NearIntentsSettle, async () => NearIntentsSettleResponse.parse(h.payment_response_pending));
    await np.x402.nearIntents.requirements({
      resource: { url: "https://merchant.example/premium" },
      amount: "1000000",
      origins: [{ asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", max_timeout_s: 1800 }],
    });
    const verify = {
      x402Version: 2,
      paymentPayload: h.payment_signature_quote,
      paymentRequirements: unquoted,
    } as never;
    const settle = {
      x402Version: 2,
      paymentPayload: h.payment_signature_deposit,
      paymentRequirements: unquoted,
    } as never;
    expect((await np.x402.nearIntents.verify(verify)).isValid).toBe(true);
    expect((await np.x402.nearIntents.settle(settle)).errorReason).toBe("settlement_pending");
    const p = gw.peer("payments");
    p.on(payCheckoutSessionTestHelper, async () => testHelperPayment());
    expect((await np.testHelpers.checkoutSessions.pay(ids.cs, { outcome: "succeeded" })).outcome).toBe("succeeded");
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
    listWebhookEndpointDeliveries,
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
    createPaymentIntent,
    reviewPaymentIntent,
    createRefund,
    getRefund,
    listRefunds,
    prepareRefund,
    submitRefundTx,
    cancelRefund,
    simulateRefundDeposit,
    createPaymentLink,
    getPaymentLink,
    listPaymentLinks,
    updatePaymentLink,
    createCustomer,
    getCustomer,
    listCustomers,
    updateCustomer,
    deleteCustomer,
    rotateWebhookEndpointSecret,
    resendEvent,
    createProduct,
    getProduct,
    listProducts,
    updateProduct,
    createPrice,
    getPrice,
    listPrices,
    updatePrice,
    createTaxRate,
    getTaxRate,
    listTaxRates,
    updateTaxRate,
    createInvoice,
    getInvoice,
    listInvoices,
    updateInvoice,
    deleteInvoice,
    finalizeInvoice,
    sendInvoice,
    voidInvoice,
    markInvoiceUncollectible,
    getInvoicePdf,
    createSubscription,
    getSubscription,
    listSubscriptions,
    updateSubscription,
    cancelSubscription,
    streamEvents,
    x402NearIntentsRequirements,
    x402NearIntentsVerify,
    x402NearIntentsSettle,
    payCheckoutSessionTestHelper,
  ].map((r) => r.id);
  expect(new Set(ids)).toEqual(new Set(covered));
});
