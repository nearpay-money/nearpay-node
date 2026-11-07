/**
 * `new NearPay(apiKey, options)` — the server SDK client (lld/sdks-and-tools.md §1).
 */
import { API_VERSION } from "@nearpay/spec";
import type { ResponseValidation } from "./http/parse.js";
import { Transport, type ValidationIssueReport } from "./http/transport.js";
import { type BoundResources, bindResources } from "./resources/bind.js";
import { RESOURCES, type Resources } from "./resources/routes.js";
import { type RefundCalls, type RefundSigners, refundSigners } from "./signing/signers.js";
import { type Webhooks, webhooks } from "./webhooks/verify.js";

export const DEFAULT_BASE_URL = "https://api.nearpay.money";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

export interface NearPayOptions {
  /** API origin; default `https://api.nearpay.money` (local stack: `https://api.nearpay.localhost`). */
  readonly baseUrl?: string;
  /** `NearPay-Version` pinned for every call of this client; default the spec's current version. */
  readonly apiVersion?: string;
  /** Per-attempt timeout in milliseconds; default 30 000. */
  readonly timeoutMs?: number;
  /**
   * Retries after the first attempt; default 2. 429 and 409 `idempotency_in_progress` are always
   * retried; 5xx, timeouts and dropped connections only on replay-safe routes (GET, DELETE, routes
   * honouring the Idempotency-Key) — see `src/http/transport.ts`.
   */
  readonly maxRetries?: number;
  /** `fetch` implementation; default the global one (Node ≥ 22). */
  readonly fetch?: typeof fetch;
  /** Your application, appended to the User-Agent (`merchant-demo/1.0`). */
  readonly appInfo?: string;
  /** Backoff base / cap in milliseconds (defaults 500 / 8 000). */
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  /**
   * How responses are checked against `@nearpay/spec` (always tolerant of new open-enum values and
   * new event types): `"tolerant"` (default) returns a non-matching body as received and reports it
   * (`lastResponse.validationIssues`, `onValidationIssue`); `"strict"` throws
   * `NearPayResponseValidationError`; `"off"` skips parsing.
   */
  readonly responseValidation?: ResponseValidation;
  /** Called for each response that does not match the spec; default: one process warning per route. */
  readonly onValidationIssue?: (report: ValidationIssueReport) => void;
}

type Bound = BoundResources<Resources>;

/** `nearpay.refunds`: the refund routes plus `signers` (lld/sdks-and-tools.md §1). */
export type RefundsResource = Bound["refunds"] & {
  /** Sign or broadcast a refund leg's `next_action` with your own wallet, and report it. */
  readonly signers: RefundSigners;
};

const KEY_RE = /^(sk|rk)_(live|test)_[0-9A-Za-z]+$/;

export class NearPay {
  readonly checkout: Bound["checkout"];
  readonly paymentIntents: Bound["paymentIntents"];
  readonly refunds: RefundsResource;
  readonly paymentLinks: Bound["paymentLinks"];
  readonly customers: Bound["customers"];
  readonly balanceTransactions: Bound["balanceTransactions"];
  readonly settlementDestinations: Bound["settlementDestinations"];
  readonly webhookEndpoints: Bound["webhookEndpoints"];
  readonly events: Bound["events"];
  readonly webhookSigningKeys: Bound["webhookSigningKeys"];
  readonly agentPayments: Bound["agentPayments"];
  readonly x402: Bound["x402"];
  readonly assets: Bound["assets"];
  readonly testHelpers: Bound["testHelpers"];
  /** Webhook signature verification (needs no API call). */
  readonly webhooks: Webhooks = webhooks;
  /** `false` for `sk_test_`/`rk_test_` keys, `true` for live keys. */
  readonly livemode: boolean;

  constructor(apiKey: string, options: NearPayOptions = {}) {
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new TypeError("NearPay: an API key (sk_test_… / sk_live_…) is required");
    }
    if (apiKey.startsWith("pk_")) {
      throw new TypeError("NearPay: publishable keys (pk_…) are for browsers; use a secret key (sk_…) on the server");
    }
    if (!KEY_RE.test(apiKey)) throw new TypeError("NearPay: the API key must look like sk_test_… or rk_live_…");
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]+(\/.*)?$/.test(baseUrl)) throw new TypeError(`NearPay: invalid baseUrl ${baseUrl}`);
    this.livemode = apiKey.includes("_live_");
    const mode = options.responseValidation ?? "tolerant";
    if (!["tolerant", "strict", "off"].includes(mode)) {
      throw new TypeError(`NearPay: responseValidation must be "tolerant", "strict" or "off"`);
    }
    const transport = new Transport({
      apiKey,
      baseUrl,
      apiVersion: options.apiVersion ?? API_VERSION,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      fetch: options.fetch ?? globalThis.fetch,
      appInfo: options.appInfo,
      retryBaseMs: options.retryBaseMs ?? 500,
      retryMaxMs: options.retryMaxMs ?? 8_000,
      responseValidation: mode,
      onValidationIssue: options.onValidationIssue,
    });
    const r = bindResources(transport, RESOURCES);
    this.checkout = r.checkout;
    this.paymentIntents = r.paymentIntents;
    this.refunds = Object.freeze({ ...r.refunds, signers: refundSigners(r.refunds as unknown as RefundCalls) });
    this.paymentLinks = r.paymentLinks;
    this.customers = r.customers;
    this.balanceTransactions = r.balanceTransactions;
    this.settlementDestinations = r.settlementDestinations;
    this.webhookEndpoints = r.webhookEndpoints;
    this.events = r.events;
    this.webhookSigningKeys = r.webhookSigningKeys;
    this.agentPayments = r.agentPayments;
    this.x402 = r.x402;
    this.assets = r.assets;
    this.testHelpers = r.testHelpers;
  }
}
