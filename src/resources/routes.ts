/**
 * The SDK's resource tree: every public route of `@nearpay/spec` 0.2.0 that a server holding a
 * secret or restricted key can call, plus the anonymous reads a server needs (webhook signing keys,
 * assets, x402 `supported`). Not bound:
 * - payer routes (`client_secret`, and the anonymous payment-link `…/public` routes) — browsers and
 *   `@nearpay/js` call those;
 * - dashboard-only routes (`session` auth only): API keys, account, KYB, team, invitations,
 *   settlement-destination writes, `updateRefundRecipient` (owner + step-up, INV-7).
 * `test/unit/resources.test.ts` checks this tree against `PUBLIC_ROUTES`, so a new key-callable
 * route in the spec fails the build until it is bound here.
 *
 * Stage 3 adds billing resources (invoices, subscriptions, products, prices).
 */
import {
  advancePaymentAttempt,
  cancelPaymentIntent,
  cancelRefund,
  createCheckoutSession,
  createCustomer,
  createPaymentIntent,
  createPaymentLink,
  createRefund,
  createWebhookEndpoint,
  deleteCustomer,
  deleteWebhookEndpoint,
  expireCheckoutSession,
  getAgentPayment,
  getCheckoutSession,
  getCustomer,
  getEvent,
  getPaymentIntent,
  getPaymentLink,
  getRefund,
  getSettlementDestination,
  getWebhookEndpoint,
  listAgentPayments,
  listAssets,
  listBalanceTransactions,
  listCheckoutSessions,
  listCustomers,
  listEvents,
  listPaymentIntents,
  listPaymentLinks,
  listRefunds,
  listSettlementDestinations,
  listWebhookEndpointDeliveries,
  listWebhookEndpoints,
  listWebhookSigningKeys,
  prepareRefund,
  resendEvent,
  reviewPaymentIntent,
  rotateWebhookEndpointSecret,
  simulateRefundDeposit,
  submitRefundTx,
  testWebhookEndpoint,
  updateCustomer,
  updatePaymentLink,
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
    refunds: {
      simulateDeposit: simulateRefundDeposit,
    },
  },
} as const;

export type Resources = typeof RESOURCES;
