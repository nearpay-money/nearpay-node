/**
 * The SDK's resource tree: every public route of `@nearpay/spec` 0.3.0 that a server holding a
 * secret or restricted key can call, plus the anonymous reads a server needs (webhook signing keys,
 * assets, x402 `supported`). Not bound:
 * - payer routes (`client_secret`, and the anonymous payment-link `…/public` routes) — browsers and
 *   `@nearpay/js` call those;
 * - dashboard-only routes (`session` auth only): API keys, account, KYB, team, invitations,
 *   settlement-destination writes, `updateRefundRecipient` (owner + step-up, INV-7), CLI login
 *   approval;
 * - the hosted-invoice payer routes (`/v1/invoices/{id}/public/**`, invoice secret) — the hosted
 *   invoice page and agents (`@nearpay/mcp`) call those.
 * `test/unit/resources.test.ts` checks this tree against `PUBLIC_ROUTES`, so a new key-callable
 * route in the spec fails the build until it is bound here.
 *
 * Stage 3 (0.3.0): billing (`products`, `prices`, `taxRates`, `invoices` incl. `pdf` as bytes,
 * `subscriptions`), cross-chain x402 (`x402.nearIntents.*`), the events stream (`events.stream`, an
 * async iterator — `src/events/stream.ts`) and `testHelpers.checkoutSessions.pay`. Routes with a
 * binary body or an SSE stream are dispatched by `bindRoute` on `binaryResponse` / `stream`.
 */
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
  markInvoiceUncollectible,
  payCheckoutSessionTestHelper,
  prepareRefund,
  resendEvent,
  reviewPaymentIntent,
  rotateWebhookEndpointSecret,
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
  voidInvoice,
  x402NearIntentsRequirements,
  x402NearIntentsSettle,
  x402NearIntentsVerify,
  x402Requirements,
  x402Settle,
  x402Supported,
  x402Verify,
} from "@nearpay/spec";

export const RESOURCES = {
  checkout: {
    sessions: {
      create: createCheckoutSession,
      retrieve: getCheckoutSession,
      list: listCheckoutSessions,
      expire: expireCheckoutSession,
    },
  },
  paymentIntents: {
    create: createPaymentIntent,
    retrieve: getPaymentIntent,
    list: listPaymentIntents,
    cancel: cancelPaymentIntent,
    review: reviewPaymentIntent,
  },
  refunds: {
    create: createRefund,
    retrieve: getRefund,
    list: listRefunds,
    prepare: prepareRefund,
    submitTx: submitRefundTx,
    cancel: cancelRefund,
  },
  paymentLinks: {
    create: createPaymentLink,
    retrieve: getPaymentLink,
    list: listPaymentLinks,
    update: updatePaymentLink,
  },
  customers: {
    create: createCustomer,
    retrieve: getCustomer,
    list: listCustomers,
    update: updateCustomer,
    del: deleteCustomer,
  },
  balanceTransactions: {
    list: listBalanceTransactions,
  },
  // stage 3 — billing
  products: {
    create: createProduct,
    retrieve: getProduct,
    list: listProducts,
    update: updateProduct,
  },
  prices: {
    create: createPrice,
    retrieve: getPrice,
    list: listPrices,
    update: updatePrice,
  },
  taxRates: {
    create: createTaxRate,
    retrieve: getTaxRate,
    list: listTaxRates,
    update: updateTaxRate,
  },
  invoices: {
    create: createInvoice,
    retrieve: getInvoice,
    list: listInvoices,
    update: updateInvoice,
    del: deleteInvoice,
    finalize: finalizeInvoice,
    send: sendInvoice,
    void: voidInvoice,
    markUncollectible: markInvoiceUncollectible,
    /** `application/pdf` bytes (`Uint8Array`), not JSON. */
    pdf: getInvoicePdf,
  },
  subscriptions: {
    create: createSubscription,
    retrieve: getSubscription,
    list: listSubscriptions,
    update: updateSubscription,
    cancel: cancelSubscription,
  },
  settlementDestinations: {
    retrieve: getSettlementDestination,
    list: listSettlementDestinations,
  },
  webhookEndpoints: {
    create: createWebhookEndpoint,
    retrieve: getWebhookEndpoint,
    list: listWebhookEndpoints,
    update: updateWebhookEndpoint,
    del: deleteWebhookEndpoint,
    test: testWebhookEndpoint,
    listDeliveries: listWebhookEndpointDeliveries,
    rotateSecret: rotateWebhookEndpointSecret,
  },
  events: {
    retrieve: getEvent,
    list: listEvents,
    resend: resendEvent,
    /** Server-sent events: an `EventStream` (async iterator with resume), not a promise. */
    stream: streamEvents,
  },
  webhookSigningKeys: {
    list: listWebhookSigningKeys,
  },
  agentPayments: {
    retrieve: getAgentPayment,
    list: listAgentPayments,
  },
  x402: {
    supported: x402Supported,
    requirements: x402Requirements,
    verify: x402Verify,
    settle: x402Settle,
    // stage 3 — cross-chain x402 (`exact` + `near-intents`)
    nearIntents: {
      requirements: x402NearIntentsRequirements,
      verify: x402NearIntentsVerify,
      settle: x402NearIntentsSettle,
    },
  },
  assets: {
    list: listAssets,
  },
  testHelpers: {
    paymentAttempts: {
      advance: advancePaymentAttempt,
    },
    refunds: {
      simulateDeposit: simulateRefundDeposit,
    },
    checkoutSessions: {
      /** Pays an open test-mode session through the sandbox (`nearpay trigger`). */
      pay: payCheckoutSessionTestHelper,
    },
  },
} as const;

export type Resources = typeof RESOURCES;
