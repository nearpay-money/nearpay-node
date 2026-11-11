/**
 * Every resource method against the spec-validating mock (`test/support/spec-mock.ts`): requests are
 * parsed strictly with the route's schemas, responses come from spec-valid fixtures, and the client
 * runs with `responseValidation: "strict"`, so a passing call proves both directions match the spec.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  agentPayment,
  balanceTransaction,
  checkoutSession,
  paymentIntent,
  settlementDestination,
} from "@nearpay-internal/testing";
import {
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
  X402PaymentRequiredAny,
  x402NearIntentsRequirements,
  x402NearIntentsSettle,
  x402NearIntentsVerify,
  x402Requirements,
  x402Settle,
  x402Supported,
  x402Verify,
} from "@nearpay-money/spec";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  NearPay,
  NearPayIdempotencyError,
  NearPayInvalidRequestError,
  NearPayPermissionError,
  NearPayStateConflictError,
} from "../../src/index.js";
import { routesOf } from "../../src/resources/bind.js";
import { RESOURCES } from "../../src/resources/routes.js";
import {
  createdPaymentIntent,
  customer,
  deletedCustomer,
  deletedInvoice,
  delivery,
  event,
  eventResend,
  ids,
  intentsVectors,
  invoice,
  now,
  PAYER,
  page,
  paymentLink,
  price,
  product,
  refund,
  signIntentAction,
  streamReady,
  streamReset,
  subscription,
  taxRate,
  testHelperPayment,
  USDC_NEAR,
  webhookEndpoint,
} from "../support/fixtures.js";
import { MockApiError, openSseResponse, type SpecMock, sseFrame, startSpecMock } from "../support/spec-mock.js";

const require = createRequire(import.meta.url);
const niVectors = JSON.parse(
  readFileSync(require.resolve("@nearpay-money/spec/test-vectors/x402-near-intents.json"), "utf8"),
) as { headers: Record<string, { accepts?: unknown[] } & Record<string, unknown>> };

const KEY = "sk_test_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
let mock: SpecMock;
let np: NearPay;
const covered = new Set<string>();
const cover = (...routes: { id: string }[]) => {
  for (const r of routes) covered.add(r.id);
};

beforeAll(async () => {
  mock = await startSpecMock();
  np = new NearPay(KEY, { baseUrl: mock.url, maxRetries: 0, responseValidation: "strict" });
});
afterAll(() => mock.close());
afterEach(() => {
  expect(mock.violations).toEqual([]);
  mock.reset();
});

describe("checkout sessions", () => {
  it("create, retrieve (expand), list (grouped created filter), expire", async () => {
    const s = checkoutSession();
    mock.on(createCheckoutSession, (r) => ({
      ...s,
      amount: r.body.amount,
      customer: (r.body.customer ?? null) as typeof s.customer,
    }));
    mock.on(getCheckoutSession, () => s);
    mock.on(listCheckoutSessions, () => page("/v1/checkout/sessions", [s]));
    mock.on(expireCheckoutSession, () => ({ ...s, status: "expired" as const }));
    const created = await np.checkout.sessions.create({
      amount: 200,
      currency: "usd",
      success_url: "https://merchant.example/ok",
      customer: ids.cus,
      metadata: { order_id: "42" },
    });
    expect(created).toMatchObject({ id: s.id, amount: 200 });
    expect(created.lastResponse?.statusCode).toBe(201);
    await np.checkout.sessions.retrieve(s.id, { expand: ["payment_intent"] });
    await np.checkout.sessions.list({ created: { gte: 1, lte: now() }, status: "open" });
    expect((await np.checkout.sessions.expire(s.id)).status).toBe("expired");
    expect(mock.callsTo(getCheckoutSession)[0]?.query).toEqual({ expand: ["payment_intent"] });
    expect(mock.callsTo(listCheckoutSessions)[0]?.query).toMatchObject({ "created[gte]": 1, status: "open" });
    cover(createCheckoutSession, getCheckoutSession, listCheckoutSessions, expireCheckoutSession);
  });
});

describe("payment intents", () => {
  it("create returns the client secret once; retrieve, cancel, review", async () => {
    const created = createdPaymentIntent();
    const pi = paymentIntent();
    mock.on(createPaymentIntent, () => created);
    mock.on(getPaymentIntent, () => pi);
    mock.on(cancelPaymentIntent, (r) => ({
      ...pi,
      status: "canceled" as const,
      cancellation_reason: r.body.cancellation_reason ?? null,
    }));
    mock.on(reviewPaymentIntent, (r) => {
      if (r.body.decision === "accept") throw new MockApiError("review_requires_evidence");
      return { ...pi, status: "requires_payment" as const };
    });
    const c = await np.paymentIntents.create({
      amount: 4999,
      currency: "usd",
      return_url: "https://merchant.example/return",
      customer: ids.cus,
    });
    expect(c.client_secret).toMatch(/_secret_/);
    expect(c.checkout_session).toBe(ids.cs);
    expect((await np.paymentIntents.retrieve(pi.id)).id).toBe(pi.id);
    expect((await np.paymentIntents.cancel(pi.id, { cancellation_reason: "duplicate" })).status).toBe("canceled");
    const e = await np.paymentIntents.review(pi.id, { decision: "accept" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayStateConflictError);
    expect((e as NearPayStateConflictError).is("review_requires_evidence")).toBe(true);
    expect((e as NearPayStateConflictError).is("state_conflict")).toBe(false);
    expect((await np.paymentIntents.review(pi.id, { decision: "reject", create_refund: true })).status).toBe(
      "requires_payment",
    );
    cover(createPaymentIntent, getPaymentIntent, cancelPaymentIntent, reviewPaymentIntent);
  });

  it("list sends every ADR-0018 filter, grouped or flat, plus metadata[key] filters", async () => {
    mock.on(listPaymentIntents, () => page("/v1/payment_intents", [paymentIntent()]));
    await np.paymentIntents.list({
      limit: 50,
      status: "succeeded",
      created: { gte: 1_700_000_000 },
      amount: { gte: "1000", lt: "100000" },
      "amount[lte]": "99999",
      currency: "usd",
      settlement_asset_id: USDC_NEAR,
      source: "payment_link",
      customer: ids.cus,
      payment_link: ids.plink,
      checkout_session: ids.cs,
      metadata: { order_id: "42", channel: "web" },
    });
    const q = mock.callsTo(listPaymentIntents)[0]?.query as Record<string, unknown>;
    expect(q).toMatchObject({
      limit: 50,
      status: "succeeded",
      "created[gte]": 1_700_000_000,
      "amount[gte]": "1000",
      "amount[lt]": "100000",
      "amount[lte]": "99999",
      currency: "usd",
      source: "payment_link",
      customer: ids.cus,
      "metadata[order_id]": "42",
      "metadata[channel]": "web",
    });
    cover(listPaymentIntents);
  });

  it("an invalid filter is the API's invalid_request (no client-side validation)", async () => {
    const e = await np.paymentIntents
      .list({ metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])) })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayInvalidRequestError);
    mock.violations.splice(0); // the mock flags the request as a violation, which is the point here
  });
});

describe("refunds", () => {
  it("create, retrieve, list, prepare, submitTx, cancel, simulate deposit", async () => {
    const action = signIntentAction({ signerId: "merchant.near" });
    const r = refund({ next_action: action });
    mock.on(createRefund, (req) => ({ ...r, amount: req.body.amount ?? r.amount }));
    mock.on(getRefund, () => r);
    mock.on(listRefunds, () => page("/v1/refunds", [r]));
    mock.on(prepareRefund, () => r);
    mock.on(submitRefundTx, () => ({ ...r, status: "pending" as const, next_action: null }));
    mock.on(cancelRefund, (req) => {
      if (mock.callsTo(cancelRefund).length > 1) throw new MockApiError("state_conflict");
      return {
        ...r,
        status: "canceled" as const,
        next_action: null,
        canceled_at: now(),
        id: req.params.id as typeof r.id,
      };
    });
    mock.on(simulateRefundDeposit, () => undefined);
    const created = await np.refunds.create({
      payment_intent: ids.pi,
      amount: "2000000",
      reason: "requested_by_customer",
      metadata: { ticket: "T-1" },
    });
    expect(created.next_action?.type).toBe("sign_intent");
    expect(mock.callsTo(createRefund)[0]?.body).toMatchObject({ fee_mode: "payer_absorbs" });
    expect((await np.refunds.retrieve(r.id)).id).toBe(r.id);
    await np.refunds.list({ payment_intent: ids.pi, status: "requires_action" });
    await np.refunds.prepare(r.id);
    const submitted = await np.refunds.submitTx(r.id, { tx_hash: "0xabcdef0123456789", sender: "merchant.near" });
    expect(submitted.status).toBe("pending");
    await np.refunds.submitTx(r.id, { signed_intent: MultiPayload.parse(intentsVectors.nep413.multipayload) });
    expect((await np.refunds.cancel(r.id)).status).toBe("canceled");
    await expect(np.refunds.cancel(r.id)).rejects.toBeInstanceOf(NearPayStateConflictError);
    await expect(np.testHelpers.refunds.simulateDeposit(r.id)).resolves.toBeUndefined();
    expect(mock.callsTo(listRefunds)[0]?.query).toMatchObject({ payment_intent: ids.pi, status: "requires_action" });
    cover(createRefund, getRefund, listRefunds, prepareRefund, submitRefundTx, cancelRefund, simulateRefundDeposit);
  });

  it("refunds.create of a definitive preparation error is a typed error", async () => {
    mock.on(createRefund, () => {
      throw new MockApiError("amount_exceeds_refundable", { param: "amount" });
    });
    const e = await np.refunds.create({ payment_intent: ids.pi, amount: "999999999" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayInvalidRequestError);
    expect((e as NearPayInvalidRequestError).param).toBe("amount");
    expect((e as NearPayInvalidRequestError).retryable).toBe(false);
  });
});

describe("payment links and customers", () => {
  it("payment links: create, retrieve, list (active), update (PATCH with a key)", async () => {
    const l = paymentLink();
    mock.on(createPaymentLink, () => l);
    mock.on(getPaymentLink, () => l);
    mock.on(listPaymentLinks, () => page("/v1/payment_links", [l]));
    mock.on(updatePaymentLink, (r) => ({ ...l, active: r.body.active ?? l.active }));
    await np.paymentLinks.create({ amount: 2500, currency: "usd", description: "T-shirt", collect_email: true });
    await np.paymentLinks.retrieve(l.id);
    await np.paymentLinks.list({ active: true });
    expect((await np.paymentLinks.update(l.id, { active: false })).active).toBe(false);
    expect(mock.callsTo(updatePaymentLink)[0]?.idempotencyKey).toBeDefined();
    cover(createPaymentLink, getPaymentLink, listPaymentLinks, updatePaymentLink);
  });

  it("customers: create, retrieve, list (email), update, del", async () => {
    const c = customer();
    mock.on(createCustomer, () => c);
    mock.on(getCustomer, () => c);
    mock.on(listCustomers, () => page("/v1/customers", [c]));
    mock.on(updateCustomer, (r) => ({ ...c, name: r.body.name ?? c.name }));
    mock.on(deleteCustomer, () => deletedCustomer());
    await np.customers.create({
      email: "ada@example.com",
      name: "Ada",
      wallets: [{ chain: "near:mainnet", address: "ada.near" }],
    });
    await np.customers.retrieve(c.id);
    await np.customers.list({ email: "ada@example.com" });
    expect((await np.customers.update(c.id, { name: "Ada L." })).name).toBe("Ada L.");
    const gone = await np.customers.del(c.id);
    expect(gone.deleted).toBe(true);
    expect(mock.callsTo(deleteCustomer)[0]?.idempotencyKey).toBeUndefined();
    cover(createCustomer, getCustomer, listCustomers, updateCustomer, deleteCustomer);
  });
});

describe("webhooks and events", () => {
  it("endpoints: create, retrieve, list, update, test, deliveries, rotate secret, del", async () => {
    const we = webhookEndpoint();
    const secret = `whsec_${"b".repeat(32)}`;
    mock.on(createWebhookEndpoint, () => ({ ...we, secret: `whsec_${"a".repeat(32)}` }));
    mock.on(getWebhookEndpoint, () => we);
    mock.on(listWebhookEndpoints, () => page("/v1/webhook_endpoints", [we]));
    mock.on(updateWebhookEndpoint, () => we);
    mock.on(testWebhookEndpoint, () => event("ping", { object: "ping", webhook_endpoint: we.id }));
    mock.on(listWebhookEndpointDeliveries, () => page(`/v1/webhook_endpoints/${we.id}/deliveries`, [delivery()]));
    mock.on(rotateWebhookEndpointSecret, (r) => ({
      ...we,
      secret,
      previous_secret_expires_at: now() + (r.body.expire_previous_in_seconds ?? 86_400),
    }));
    mock.on(deleteWebhookEndpoint, () => undefined);
    await np.webhookEndpoints.create({ url: we.url, enabled_events: ["refund.succeeded", "review.opened"] });
    await np.webhookEndpoints.retrieve(we.id);
    await np.webhookEndpoints.list({ limit: 3 });
    await np.webhookEndpoints.update(we.id, { description: "prod" });
    expect((await np.webhookEndpoints.test(we.id)).type).toBe("ping");
    await np.webhookEndpoints.listDeliveries(we.id, { limit: 1 });
    const rotated = await np.webhookEndpoints.rotateSecret(we.id, { expire_previous_in_seconds: 3600 });
    expect(rotated.secret).toBe(secret);
    expect(rotated.previous_secret_expires_at).toBeGreaterThan(now());
    const defaulted = await np.webhookEndpoints.rotateSecret(we.id);
    expect(defaulted.previous_secret_expires_at).toBeGreaterThan(now() + 80_000);
    await expect(np.webhookEndpoints.del(we.id)).resolves.toBeUndefined();
    cover(
      createWebhookEndpoint,
      getWebhookEndpoint,
      listWebhookEndpoints,
      updateWebhookEndpoint,
      testWebhookEndpoint,
      listWebhookEndpointDeliveries,
      rotateWebhookEndpointSecret,
      deleteWebhookEndpoint,
    );
  });

  it("events: retrieve (typed refund event), list, resend; signing keys anonymously", async () => {
    const r = refund({ status: "succeeded", next_action: null, succeeded_at: now() });
    const ev = event("refund.succeeded", r);
    mock.on(getEvent, () => ev);
    mock.on(listEvents, () => page("/v1/events", [ev]));
    mock.on(resendEvent, () => eventResend());
    mock.on(listWebhookSigningKeys, () =>
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
    const got = await np.events.retrieve(ev.id);
    expect(got.type).toBe("refund.succeeded");
    await np.events.list({ type: "refund.succeeded", created: { lte: now() + 5 } });
    const resent = await np.events.resend(ev.id, { endpoint: ids.we });
    expect(resent.deliveries).toHaveLength(1);
    expect((await np.webhookSigningKeys.list()).keys[0]?.kid).toBe("wh-1");
    cover(getEvent, listEvents, resendEvent, listWebhookSigningKeys);
  });
});

describe("balance, destinations, assets, agent payments, x402, test helpers", () => {
  it("reads balance transactions (refund filter), destinations and assets", async () => {
    const sd = settlementDestination();
    mock.on(listBalanceTransactions, () => page("/v1/balance_transactions", [balanceTransaction()]));
    mock.on(listSettlementDestinations, () => page("/v1/settlement_destinations", [sd]));
    mock.on(getSettlementDestination, () => sd);
    mock.on(listAssets, () => ({
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
    await np.balanceTransactions.list({ refund: ids.re });
    await np.settlementDestinations.list({ status: "active" });
    await np.settlementDestinations.retrieve(sd.id);
    expect((await np.assets.list()).data[0]?.symbol).toBe("USDC");
    expect(mock.callsTo(listBalanceTransactions)[0]?.query).toMatchObject({ refund: ids.re });
    cover(listBalanceTransactions, listSettlementDestinations, getSettlementDestination, listAssets);
  });

  it("agent payments and the x402 facilitator", async () => {
    const ap = agentPayment();
    mock.on(listAgentPayments, () => page("/v1/agent_payments", [ap]));
    mock.on(getAgentPayment, () => ap);
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
        binding: intentsVectors.binding,
        verifyingContract: "intents.near",
      },
    } as const;
    mock.on(x402Supported, () =>
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
    mock.on(x402Requirements, () =>
      PaymentRequired.parse({
        x402Version: 2,
        resource: { url: "https://merchant.example/p" },
        accepts: [requirements],
      }),
    );
    mock.on(x402Verify, () => VerifyResponse.parse({ isValid: true, payer: "agent.near" }));
    mock.on(x402Settle, () =>
      SettleResponse.parse({ success: true, transaction: "8xQ3mTn2tx", network: "near:mainnet", amount: "2000000" }),
    );
    const verifyRequest = {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: { signed: MultiPayload.parse(intentsVectors.nep413.multipayload) },
      },
      paymentRequirements: requirements,
    } as const;
    await np.agentPayments.list({ kind: "x402" });
    await np.agentPayments.retrieve(ap.id);
    await np.x402.supported();
    await np.x402.requirements({ resource: { url: "https://merchant.example/p" }, amount: "2000000" });
    expect((await np.x402.verify(verifyRequest)).isValid).toBe(true);
    expect((await np.x402.settle(verifyRequest)).success).toBe(true);
    cover(listAgentPayments, getAgentPayment, x402Supported, x402Requirements, x402Verify, x402Settle);
  });

  it("advances a test payment attempt", async () => {
    mock.on(advancePaymentAttempt, () => undefined);
    await np.testHelpers.paymentAttempts.advance(ids.pa, { to: "success" });
    expect(mock.callsTo(advancePaymentAttempt)[0]?.params).toEqual({ attempt: ids.pa });
    cover(advancePaymentAttempt);
  });
});

describe("billing (spec 0.3.0)", () => {
  it("products, prices and tax rates: create, retrieve, list (filters), update", async () => {
    mock.on(createProduct, (r) => product({ name: r.body.name }));
    mock.on(getProduct, () => product());
    mock.on(listProducts, () => page("/v1/products", [product()]));
    mock.on(updateProduct, () => product({ active: false }));
    mock.on(createPrice, () => price());
    mock.on(getPrice, () => price());
    mock.on(listPrices, () => page("/v1/prices", [price()]));
    mock.on(updatePrice, () => price({ nickname: "monthly" }));
    mock.on(createTaxRate, () => taxRate());
    mock.on(getTaxRate, () => taxRate());
    mock.on(listTaxRates, () => page("/v1/tax_rates", [taxRate()]));
    mock.on(updateTaxRate, () => taxRate({ active: false }));
    expect((await np.products.create({ name: "Pro plan" })).name).toBe("Pro plan");
    await np.products.retrieve(ids.prod);
    await np.products.list({ active: true });
    expect((await np.products.update(ids.prod, { active: false })).active).toBe(false);
    const p = await np.prices.create({
      product: ids.prod,
      unit_amount: 4900,
      currency: "usd",
      recurring: { interval: "month" },
    });
    expect(p.recurring).toEqual({ interval: "month", interval_count: 1 });
    await np.prices.retrieve(ids.price);
    await np.prices.list({ product: ids.prod, type: "recurring" });
    await np.prices.update(ids.price, { nickname: "monthly" });
    const t = await np.taxRates.create({ display_name: "VAT", percentage: "19", inclusive: false, country: "DE" });
    expect(t).toMatchObject({ percentage: "19", rate_ppm: 190_000 });
    await np.taxRates.retrieve(ids.txr);
    await np.taxRates.list({ active: true });
    await np.taxRates.update(ids.txr, { active: false });
    expect(mock.callsTo(listPrices)[0]?.query).toMatchObject({ product: ids.prod, type: "recurring" });
    expect(mock.callsTo(updateTaxRate)[0]?.idempotencyKey).toBeDefined();
    cover(createProduct, getProduct, listProducts, updateProduct, createPrice, getPrice, listPrices, updatePrice);
    cover(createTaxRate, getTaxRate, listTaxRates, updateTaxRate);
  });

  it("invoices: draft → finalize → send, list by status/due date, void, uncollectible, delete", async () => {
    const open = invoice({ status: "open" });
    mock.on(createInvoice, () => invoice());
    mock.on(getInvoice, () => open);
    mock.on(listInvoices, () => page("/v1/invoices", [open]));
    mock.on(updateInvoice, () => invoice({ footer: "Thanks" }));
    mock.on(finalizeInvoice, () => open);
    mock.on(sendInvoice, () => ({ ...open, status_transitions: { ...open.status_transitions, sent_at: now() } }));
    mock.on(voidInvoice, () => invoice({ status: "void" }));
    mock.on(markInvoiceUncollectible, () => invoice({ status: "uncollectible", uncollectible_reason: "merchant" }));
    mock.on(deleteInvoice, () => deletedInvoice());
    const draft = await np.invoices.create({
      customer: ids.cus,
      lines: [
        { price: ids.price, quantity: 1 },
        { unit_amount: 500, description: "Setup" },
      ],
      currency: "usd",
      default_tax_rates: [ids.txr],
      days_until_due: 14,
      metadata: { order_id: "42" },
    });
    expect(draft.status).toBe("draft");
    expect(draft.lastResponse?.statusCode).toBe(201);
    await np.invoices.update(draft.id, { footer: "Thanks" });
    const finalized = await np.invoices.finalize(draft.id);
    expect(finalized.hosted_invoice_url).toMatch(/\/i\/in_.+#in_.+_secret_/);
    const sent = await np.invoices.send(draft.id);
    expect(sent.status_transitions.sent_at).not.toBeNull();
    await np.invoices.retrieve(draft.id);
    await np.invoices.list({ status: "open", customer: ids.cus, due_date: { lte: now() + 86_400 } });
    await np.invoices.void(draft.id);
    expect((await np.invoices.markUncollectible(draft.id)).uncollectible_reason).toBe("merchant");
    expect((await np.invoices.del(draft.id)).deleted).toBe(true);
    expect(mock.callsTo(createInvoice)[0]?.body).toMatchObject({ days_until_due: 14, metadata: { order_id: "42" } });
    expect(mock.callsTo(listInvoices)[0]?.query).toMatchObject({ status: "open", "due_date[lte]": expect.any(Number) });
    for (const r of [finalizeInvoice, sendInvoice, voidInvoice, markInvoiceUncollectible]) {
      expect(mock.callsTo(r)[0]?.idempotencyKey, r.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(mock.callsTo(deleteInvoice)[0]?.idempotencyKey).toBeUndefined();
    cover(createInvoice, getInvoice, listInvoices, updateInvoice, finalizeInvoice, sendInvoice);
    cover(voidInvoice, markInvoiceUncollectible, deleteInvoice);
  });

  it("maps billing errors: invoice_empty on finalize, customer_email_missing on send", async () => {
    mock.on(finalizeInvoice, () => {
      throw new MockApiError("invoice_empty");
    });
    mock.on(sendInvoice, () => {
      throw new MockApiError("customer_email_missing");
    });
    const e1 = await np.invoices.finalize(ids.in).catch((x: unknown) => x);
    expect((e1 as NearPayInvalidRequestError).code).toBe("invoice_empty");
    const e2 = await np.invoices.send(ids.in).catch((x: unknown) => x);
    expect((e2 as NearPayInvalidRequestError).code).toBe("customer_email_missing");
  });

  it("downloads the invoice PDF as bytes with its file name", async () => {
    const pdf = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");
    mock.on(getInvoicePdf, () => ({
      $binary: pdf,
      $headers: { "content-disposition": 'attachment; filename="INV-00042.pdf"', "cache-control": "private, no-store" },
    }));
    const bytes = await np.invoices.pdf(ids.in);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).equals(pdf)).toBe(true);
    expect(bytes.filename).toBe("INV-00042.pdf");
    expect(bytes.contentType).toBe("application/pdf");
    expect(bytes.lastResponse?.statusCode).toBe(200);
    expect(bytes.lastResponse?.headers["cache-control"]).toBe("private, no-store");
    const call = mock.attempts.at(-1);
    expect(call?.headers.accept).toBe("application/pdf, application/json");
    expect(call?.headers["idempotency-key"]).toBeUndefined();
    cover(getInvoicePdf);
  });

  it("PDF of a draft: the JSON error is typed; a non-PDF 200 is a contract violation", async () => {
    mock.on(getInvoicePdf, () => {
      throw new MockApiError("state_conflict");
    });
    const e = await np.invoices.pdf(ids.in).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayStateConflictError);
    mock.on(getInvoicePdf, () => ({ $binary: Buffer.from("{}"), $contentType: "application/json" }));
    const strict = await np.invoices.pdf(ids.in).catch((x: unknown) => x);
    expect((strict as Error).name).toBe("NearPayResponseValidationError");
    const reports: unknown[] = [];
    const tolerant = new NearPay(KEY, { baseUrl: mock.url, maxRetries: 0, onValidationIssue: (r) => reports.push(r) });
    const got = await tolerant.invoices.pdf(ids.in);
    expect(got.lastResponse?.validationIssues[0]?.code).toBe("content_type");
    expect(reports).toHaveLength(1);
    const off = new NearPay(KEY, { baseUrl: mock.url, maxRetries: 0, responseValidation: "off" });
    expect((await off.invoices.pdf(ids.in)).lastResponse?.validationIssues).toEqual([]);
  });

  it("subscriptions: create (trial, dunning), retrieve, list, update, cancel at period end", async () => {
    mock.on(createSubscription, () => subscription({ status: "trialing", trial_end: now() + 14 * 86_400 }));
    mock.on(getSubscription, () => subscription());
    mock.on(listSubscriptions, () => page("/v1/subscriptions", [subscription()]));
    mock.on(updateSubscription, () => subscription({ days_until_due: 14 }));
    mock.on(cancelSubscription, () => subscription({ cancel_at_period_end: true, cancellation_reason: "requested" }));
    const sub = await np.subscriptions.create({
      customer: ids.cus,
      items: [{ price: ids.price, quantity: 2, tax_rates: [ids.txr] }],
      trial_period_days: 14,
      dunning: { reminder_days: [0, 3, 7], on_exhausted: "unpaid" },
    });
    expect(sub.status).toBe("trialing");
    await np.subscriptions.retrieve(sub.id);
    await np.subscriptions.list({ customer: ids.cus, status: "active" });
    await np.subscriptions.update(sub.id, { days_until_due: 14, proration_behavior: "none" });
    const canceled = await np.subscriptions.cancel(sub.id, { at_period_end: true });
    expect(canceled.cancel_at_period_end).toBe(true);
    expect(mock.callsTo(createSubscription)[0]?.body).toMatchObject({ trial_period_days: 14 });
    cover(createSubscription, getSubscription, listSubscriptions, updateSubscription, cancelSubscription);
  });
});

describe("agent commerce (spec 0.3.0)", () => {
  it("x402 near-intents: requirements, verify (quote) and settle (deposit) are not retried after a 5xx", async () => {
    const h = niVectors.headers;
    const unquoted = (h.payment_required_unquoted?.accepts ?? [])[0];
    mock.on(x402NearIntentsRequirements, () => X402PaymentRequiredAny.parse(h.payment_required_unquoted));
    mock.on(x402NearIntentsVerify, () => NearIntentsVerifyResponse.parse(h.verify_response_quote));
    mock.on(x402NearIntentsSettle, () => NearIntentsSettleResponse.parse(h.payment_response_settled));
    const req = await np.x402.nearIntents.requirements({
      resource: { url: "https://merchant.example/premium", description: "Premium data" },
      amount: "1000000",
      origins: [{ asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" }],
    });
    expect(req.accepts).toHaveLength(1);
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
    expect((await np.x402.nearIntents.settle(settle)).success).toBe(true);
    // not replay-safe: a 503 is surfaced, never repeated
    const retrying = new NearPay(KEY, { baseUrl: mock.url, maxRetries: 2, retryBaseMs: 1, retryMaxMs: 2 });
    mock.once(x402NearIntentsSettle, (res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "api_error", code: "api_error", message: "x" } }));
    });
    await expect(retrying.x402.nearIntents.settle(settle)).rejects.toMatchObject({ statusCode: 503 });
    expect(mock.attempts.filter((a) => a.url === "/x402/near-intents/settle")).toHaveLength(2);
    cover(x402NearIntentsRequirements, x402NearIntentsVerify, x402NearIntentsSettle);
  });

  it("test helper: pays a test checkout session through the sandbox", async () => {
    mock.on(payCheckoutSessionTestHelper, (r) => testHelperPayment(r.body.outcome));
    const paid = await np.testHelpers.checkoutSessions.pay(ids.cs, { outcome: "payment_failed" });
    expect(paid).toMatchObject({ outcome: "payment_failed", payment_intent: ids.pi });
    expect(paid.lastResponse?.statusCode).toBe(202);
    await np.testHelpers.checkoutSessions.pay(ids.cs);
    expect(mock.callsTo(payCheckoutSessionTestHelper)[1]?.body).toEqual({ outcome: "succeeded" });
    cover(payCheckoutSessionTestHelper);
  });

  it("events.stream: ready, events, reset; resumes with Last-Event-ID after the server closes", async () => {
    const e1 = event("invoice.paid", invoice({ status: "paid", amount_paid: 5831, amount_remaining: 0 }), {
      id: "evt_01jbz9k3m4n5p6q7r8s9t0v1w3",
    });
    const e2 = event("customer.subscription.deleted", subscription({ status: "canceled" }), {
      id: "evt_01jbz9k3m4n5p6q7r8s9t0v1w4",
    });
    let n = 0;
    mock.on(streamEvents, () => ({
      $stream: (res) => {
        openSseResponse(res, 5);
        n++;
        if (n === 1) {
          res.write(sseFrame("ready", streamReady({ types: ["invoice.paid", "customer.subscription.deleted"] })));
          res.write(": heartbeat\n\n");
          res.write(sseFrame("event", e1, e1.id));
          res.end(); // the server's 1 h close
        } else {
          res.write(sseFrame("ready", streamReady({ resumed_after: e1.id })));
          res.write(sseFrame("event", e1, e1.id)); // at-least-once: a duplicate
          res.write(sseFrame("reset", streamReset("evt_01jbz9k3m4n5p6q7r8s9t0v1w0")));
          res.write(sseFrame("event", e2, e2.id));
          res.end();
        }
      },
    }));
    const readies: unknown[] = [];
    const resets: unknown[] = [];
    const stream = np.events.stream(
      { types: ["invoice.paid", "customer.subscription.deleted"] },
      { onReady: (r) => readies.push(r), onReset: (r) => resets.push(r) },
    );
    const got: string[] = [];
    for await (const e of stream) {
      got.push(`${e.type}:${e.id}`);
      if (got.length === 2) break;
    }
    expect(got).toEqual([`invoice.paid:${e1.id}`, `customer.subscription.deleted:${e2.id}`]);
    expect(stream.closed).toBe(true);
    expect(stream.lastEventId).toBe(e2.id);
    expect(readies).toHaveLength(2);
    expect(resets).toEqual([
      { object: "event_stream_reset", reason: "cursor_expired", cursor: "evt_01jbz9k3m4n5p6q7r8s9t0v1w0" },
    ]);
    const calls = mock.callsTo(streamEvents);
    expect(calls[0]?.query).toEqual({ types: "invoice.paid,customer.subscription.deleted" });
    expect(calls[0]?.headers["last-event-id"]).toBeUndefined();
    expect(calls[1]?.headers["last-event-id"]).toBe(e1.id);
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${KEY}`);
    cover(streamEvents);
  });

  it("events.stream: a live key is refused (403 livemode_forbidden) and the iteration throws", async () => {
    mock.on(streamEvents, () => {
      throw new MockApiError("livemode_forbidden");
    });
    const stream = np.events.stream();
    const e = await (async () => {
      for await (const _ of stream) {
        /* nothing */
      }
    })().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayPermissionError);
    expect((e as NearPayPermissionError).code).toBe("livemode_forbidden");
    expect(mock.callsTo(streamEvents)).toHaveLength(1);
  });
});

describe("credentials and idempotency against the mock", () => {
  it("a restricted key without the scope gets a permission error naming the scope", async () => {
    mock.setRestrictedScopes(["refunds.read"]);
    const rk = new NearPay("rk_test_abcdefghijklmnop", { baseUrl: mock.url, maxRetries: 0 });
    mock.on(getRefund, () => refund());
    await rk.refunds.retrieve(ids.re);
    const e = await rk.refunds.create({ payment_intent: ids.pi }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayPermissionError);
    expect((e as NearPayPermissionError).requiredScope).toBe("refunds.write");
    expect((e as Error).message).toMatch(/refunds\.write/);
    // spec 0.3.0: the sandbox helpers also admit restricted keys (the CLI key)
    const sk = await rk.testHelpers.paymentAttempts.advance(ids.pa, { to: "success" }).catch((x: unknown) => x);
    expect((sk as NearPayPermissionError).requiredScope).toBe("checkout_sessions.write");
  });

  it("the same key with the same body is replayed; another body is idempotency_key_reused", async () => {
    let n = 0;
    mock.on(createRefund, () => {
      n++;
      return refund({ next_action: signIntentAction({ signerId: "merchant.near", receiver: PAYER }) });
    });
    const body = { payment_intent: ids.pi, amount: "2000000" };
    const a = await np.refunds.create(body, { idempotencyKey: "refund-order-42" });
    const b = await np.refunds.create(body, { idempotencyKey: "refund-order-42" });
    expect(n).toBe(1);
    expect(a.lastResponse?.idempotentReplayed).toBe(false);
    expect(b.lastResponse?.idempotentReplayed).toBe(true);
    expect(b.id).toBe(a.id);
    const e = await np.refunds
      .create({ ...body, amount: "1" }, { idempotencyKey: "refund-order-42" })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayIdempotencyError);
    expect((e as NearPayIdempotencyError).code).toBe("idempotency_key_reused");
  });
});

it("covers every bound route", () => {
  const ids = routesOf(RESOURCES).map((b) => b.route.id);
  expect([...covered].sort()).toEqual([...new Set(ids)].sort());
});
