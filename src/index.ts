/**
 * @nearpay/node — NearPay server SDK (lld/sdks-and-tools.md §1).
 *
 * ```ts
 * import { NearPay } from "@nearpay/node";
 * const nearpay = new NearPay(process.env.NEARPAY_SECRET_KEY!);
 * const session = await nearpay.checkout.sessions.create({ amount: 200, currency: "usd", success_url: "https://shop.example/ok" });
 * for await (const pi of nearpay.paymentIntents.list({ status: "succeeded", metadata: { order_id: "42" } })) { … }
 * const event = nearpay.webhooks.constructEvent(rawBody, req.headers["nearpay-signature"], process.env.NEARPAY_WEBHOOK_SECRET!);
 * const invoice = await nearpay.invoices.finalize((await nearpay.invoices.create({ customer: "cus_…", lines: [{ price: "price_…" }] })).id);
 * for await (const e of nearpay.events.stream({ types: ["invoice.paid"] })) { … } // test mode keys
 * ```
 */
export type {
  Account,
  AgentPayment,
  BalanceTransaction,
  CheckoutSession,
  Customer,
  ErrorCode,
  Event,
  EventDataObject,
  Invoice,
  MultiPayload,
  PaymentIntent,
  PaymentLink,
  Price,
  Product,
  PublicReview,
  Refund,
  RefundNextAction,
  SettlementDestination,
  Subscription,
  TaxRate,
  TypedEvent,
  UnknownEnumValue,
  WebhookObjectOf,
  WebhookType,
} from "@nearpay/spec";
export {
  API_VERSION,
  computeInvoiceTotals,
  computeLineTax,
  EVENT_STREAM_MAX_SECONDS,
  HEADERS,
  SPEC_VERSION,
  taxPercentageToPpm,
} from "@nearpay/spec";
export {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type EventsResource,
  type InvoicesResource,
  NearPay,
  NearPay as default,
  type NearPayOptions,
  type RefundsResource,
} from "./client.js";
export {
  type EventStream,
  type EventStreamOptions,
  type EventStreamParams,
  type EventStreamReadyFrame,
  type EventStreamReconnect,
  type EventStreamResetFrame,
  isRetryableStreamError,
  type SseFrame,
  SseParser,
} from "./events/stream.js";
export {
  type ErrorFields,
  NearPayApiError,
  NearPayAuthenticationError,
  NearPayConnectionError,
  NearPayError,
  type NearPayErrorInit,
  NearPayIdempotencyError,
  NearPayInvalidRequestError,
  NearPayPaymentError,
  NearPayPermissionError,
  NearPayRailUnavailableError,
  NearPayRateLimitError,
  NearPayResponseValidationError,
  NearPaySignatureVerificationError,
  NearPayStateConflictError,
} from "./http/errors.js";
export type { ResponseValidation, ValidationIssue } from "./http/parse.js";
export {
  type BinaryResult,
  REPLAY_SAFE_POSTS,
  type RequestOptions,
  type ResponseMeta,
  type ValidationIssueReport,
} from "./http/transport.js";
export type {
  BoundResources,
  RouteBodyInput,
  RouteListItem,
  RouteMethod,
  RouteQueryInput,
  RouteResult,
  RouteReturn,
} from "./resources/bind.js";
export { AUTO_PAGING_MAX, type AutoPagingOptions, type ListPage, type ListPromise } from "./resources/pagination.js";
export { RESOURCES, type Resources } from "./resources/routes.js";
export { type MethodAccess, type MethodPath, methodAccess, restrictedKeyScope, scopesFor } from "./resources/scopes.js";
export {
  type ChainTransfer,
  type CheckedRefundAction,
  type CheckOptions,
  chainTransferOf,
  checkRefundAction,
  type EvmMessageAccountLike,
  type EvmTransferRequest,
  type EvmWalletLike,
  evmAccountSigner,
  evmTransferRequest,
  evmWalletSender,
  type IntentSigner,
  type NearKeyPairLike,
  NearPayRefundSigningError,
  nearKeyPairSigner,
  type RefundSignAndSendAction,
  type RefundSignIntentAction,
  signRefundIntent,
  type TransferSender,
} from "./signing/refunds.js";
export type { RefundSigners, SignAndSubmitOptions } from "./signing/signers.js";
export type {
  CreatedPaymentIntent,
  DeletedCustomer,
  DeletedInvoice,
  EventResend,
  InvoiceLineItem,
  SubscriptionItem,
  TestHelperPayment,
  WebhookDelivery,
  WebhookEndpoint,
} from "./types.js";
export { SDK_VERSION } from "./version.js";
export {
  computeV1Signature,
  constructEvent,
  generateTestHeaderString,
  type NearPayEvent,
  parseEvent,
  type RawBody,
  type VerifyOptions,
  verifyEd25519,
  type WebhookJwks,
  type WebhookObject,
  type WebhookSecret,
  type WebhookSecretEntry,
  type WebhookSigningJwk,
  type Webhooks,
  webhooks,
} from "./webhooks/verify.js";
