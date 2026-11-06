/**
 * @nearpay/node — NearPay server SDK (lld/sdks-and-tools.md §1, Stage 1 subset).
 *
 * ```ts
 * import { NearPay } from "@nearpay/node";
 * const nearpay = new NearPay(process.env.NEARPAY_SECRET_KEY!);
 * const session = await nearpay.checkout.sessions.create({ amount: 200, currency: "usd", success_url: "https://shop.example/ok" });
 * const event = nearpay.webhooks.constructEvent(rawBody, req.headers["nearpay-signature"], process.env.NEARPAY_WEBHOOK_SECRET!);
 * ```
 */
export type {
  AgentPayment,
  BalanceTransaction,
  CheckoutSession,
  ErrorCode,
  Event,
  PaymentIntent,
  SettlementDestination,
  WebhookType,
} from "@nearpay/spec";
export { API_VERSION, HEADERS, SPEC_VERSION } from "@nearpay/spec";
export {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  NearPay,
  NearPay as default,
  type NearPayOptions,
} from "./client.js";
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
  NearPaySignatureVerificationError,
  NearPayStateConflictError,
} from "./http/errors.js";
export type { RequestOptions, ResponseMeta } from "./http/transport.js";
export type {
  BoundResources,
  RouteBodyInput,
  RouteMethod,
  RouteQueryInput,
  RouteResult,
} from "./resources/bind.js";
export { RESOURCES, type Resources } from "./resources/routes.js";
export type { WebhookDelivery } from "./types.js";
export { SDK_VERSION } from "./version.js";
export {
  computeV1Signature,
  constructEvent,
  generateTestHeaderString,
  type NearPayEvent,
  type RawBody,
  type VerifyOptions,
  verifyEd25519,
  type WebhookJwks,
  type WebhookObject,
  type WebhookSecret,
  type WebhookSigningJwk,
  type Webhooks,
  webhooks,
} from "./webhooks/verify.js";
