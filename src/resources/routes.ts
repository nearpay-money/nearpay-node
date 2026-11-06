/**
 * The SDK's resource tree: Stage 1 public routes of `@nearpay/spec` 0.1.4 that a server holding a
 * secret or restricted key calls, plus the anonymous reads a server needs (webhook signing keys,
 * assets, x402 `supported`). Payer routes (`client_secret`) and dashboard routes (`session` only)
 * are not part of a server SDK. `test/unit/resources.test.ts` checks this tree against `PUBLIC_ROUTES`,
 * so a new key-callable route in the spec fails the build until it is bound here.
 *
 * Stage 2 adds refunds (with `refunds.signers`), payment links, customers; Stage 3 billing resources.
 */
import {
  advancePaymentAttempt,
  cancelPaymentIntent,
  createCheckoutSession,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
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
  testWebhookEndpoint,
  updateWebhookEndpoint,
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
    retrieve: getPaymentIntent,
    list: listPaymentIntents,
    cancel: cancelPaymentIntent,
  },
  balanceTransactions: {
    list: listBalanceTransactions,
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
  },
  events: {
    retrieve: getEvent,
    list: listEvents,
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
  },
  assets: {
    list: listAssets,
  },
  testHelpers: {
    paymentAttempts: {
      advance: advancePaymentAttempt,
    },
  },
} as const;

export type Resources = typeof RESOURCES;
