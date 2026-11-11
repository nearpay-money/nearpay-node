/**
 * Typed errors (lld/sdks-and-tools.md §1): one `NearPayError` subclass per error `type` of the
 * error envelope (architecture/api-conventions.md §6), each carrying the catalogue `code`, the HTTP
 * status and the `requestId` to quote to NearPay support.
 */
import { ERRORS, type ErrorCode, type ErrorType, HEADERS } from "@nearpay-money/spec";
import type { ValidationIssue } from "./parse.js";

/** Fields of an API error envelope (`{error: {...}}`); unknown fields are kept in `raw`. */
export interface ErrorFields {
  readonly type: string;
  readonly code: string;
  readonly message: string;
  readonly param?: string | undefined;
  readonly doc_url?: string | undefined;
  readonly request_id?: string | undefined;
}

export interface NearPayErrorInit {
  readonly message: string;
  readonly type?: string | undefined;
  readonly code?: string | undefined;
  readonly statusCode?: number | undefined;
  readonly param?: string | undefined;
  readonly docUrl?: string | undefined;
  readonly requestId?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly raw?: unknown;
  readonly cause?: unknown;
  /** Restricted-key scope the failed call needs (set on permission errors of `rk_…` clients). */
  readonly requiredScope?: string | undefined;
}

/** Catalogue entry of a code (status, type, whether a retry can help), if the code is known. */
export function catalogueEntry(code: string | undefined) {
  return code !== undefined && Object.hasOwn(ERRORS, code) ? ERRORS[code as ErrorCode] : undefined;
}

/** Base class of every error the SDK throws. */
export class NearPayError extends Error {
  /** Error `type` from the envelope (`invalid_request_error`, `api_error`, …); `connection_error` for network failures. */
  readonly type: string;
  /** Catalogue code (`resource_missing`, `idempotency_in_progress`, …). */
  readonly code: string | undefined;
  /** HTTP status; undefined when no response arrived. */
  readonly statusCode: number | undefined;
  /** The request parameter the error is about. */
  readonly param: string | undefined;
  readonly docUrl: string | undefined;
  /** `req_…` id from the envelope or the `X-Request-Id` header. */
  readonly requestId: string | undefined;
  /** Response headers (lower-case names). */
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed response body, if any. */
  readonly raw: unknown;
  /**
   * Whether repeating the same request (same Idempotency-Key) can succeed: the catalogue's
   * `retryable` for known codes, else 429/5xx. The SDK already retried what it safely could.
   */
  readonly retryable: boolean;
  /** For permission errors of a restricted key: the scope this call needs (`refunds.write`). */
  readonly requiredScope: string | undefined;

  constructor(init: NearPayErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.type = init.type ?? "api_error";
    this.code = init.code;
    this.statusCode = init.statusCode;
    this.param = init.param;
    this.docUrl = init.docUrl;
    this.requestId = init.requestId;
    this.headers = init.headers ?? {};
    this.raw = init.raw;
    const entry = catalogueEntry(init.code);
    this.retryable = entry
      ? entry.retryable
      : init.statusCode !== undefined && (init.statusCode === 429 || init.statusCode >= 500);
    this.requiredScope = init.requiredScope;
  }

  /** Narrows on a catalogue code: `if (e instanceof NearPayError && e.is("amount_exceeds_refundable"))`. */
  is(code: ErrorCode): boolean {
    return this.code === code;
  }
}

/** 400/404: the request is invalid (`invalid_request`, `resource_missing`, route-specific codes). */
export class NearPayInvalidRequestError extends NearPayError {}
/** 401: missing, invalid, expired or revoked key. */
export class NearPayAuthenticationError extends NearPayError {}
/** 403: the key may not perform this action (scope, role, test-mode-only route, …). */
export class NearPayPermissionError extends NearPayError {}
/** 402: payment blocked (for example by compliance). */
export class NearPayPaymentError extends NearPayError {}
/** 409: `idempotency_key_reused` / `idempotency_in_progress`. */
export class NearPayIdempotencyError extends NearPayError {}
/** 409: the object is not in a state that allows the action. */
export class NearPayStateConflictError extends NearPayError {}
/** 429: rate limited; retried automatically, honouring `Retry-After`. */
export class NearPayRateLimitError extends NearPayError {}
/** 5xx: NearPay-side failure; retried automatically with the same Idempotency-Key. */
export class NearPayApiError extends NearPayError {}
/** 503: the upstream route provider is unavailable; retry later. */
export class NearPayRailUnavailableError extends NearPayError {}
/** No response: DNS/TCP/TLS failure, timeout or abort. */
export class NearPayConnectionError extends NearPayError {
  /** The attempt hit the client timeout. */
  readonly timedOut: boolean;
  /** The outcome is unknown: repeating the call with the same Idempotency-Key is safe. */
  override readonly retryable: boolean = true;
  constructor(init: NearPayErrorInit & { readonly timedOut?: boolean }) {
    super({ ...init, type: "connection_error" });
    this.timedOut = init.timedOut ?? false;
  }
}
/**
 * A response (or webhook payload) does not match `@nearpay-money/spec` — thrown only with
 * `responseValidation: "strict"` (or `constructEvent(…, {validation: "strict"})`). For a write,
 * the server already applied it: retry with `idempotencyKey` to get the stored response.
 */
export class NearPayResponseValidationError extends NearPayError {
  /** The fields that do not match. */
  readonly issues: readonly ValidationIssue[];
  /** Idempotency-Key of the call (POST/PATCH), for a replay-safe retry. */
  readonly idempotencyKey: string | undefined;
  constructor(
    init: NearPayErrorInit & { readonly issues: readonly ValidationIssue[]; readonly idempotencyKey?: string },
  ) {
    super({ ...init, type: "response_validation_error", code: init.code ?? "response_invalid" });
    this.issues = init.issues;
    this.idempotencyKey = init.idempotencyKey;
  }
}
/** A webhook signature could not be verified (`webhooks.constructEvent` / `verifyEd25519`). */
export class NearPaySignatureVerificationError extends NearPayError {
  constructor(message: string) {
    super({ message, type: "signature_verification_error", code: "signature_invalid" });
  }
}

const BY_TYPE: Readonly<Record<ErrorType, new (init: NearPayErrorInit) => NearPayError>> = {
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

function isErrorFields(v: unknown): v is ErrorFields {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.type === "string" && typeof o.code === "string" && typeof o.message === "string";
}

/** Builds the typed error for a non-2xx response. Unknown error types map to the base class. */
export function errorFromResponse(
  statusCode: number,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  requiredScope?: string,
) {
  const env = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  const requestIdHeader = headers[HEADERS.requestId.toLowerCase()];
  if (!isErrorFields(env)) {
    // not an envelope (a proxy page, an empty body): classify by status
    const type = statusCode === 429 ? "rate_limit_error" : statusCode >= 500 ? "api_error" : "invalid_request_error";
    const Ctor = BY_TYPE[type];
    return new Ctor({
      message: `NearPay API responded ${statusCode} without an error envelope`,
      type,
      code: undefined,
      statusCode,
      requestId: requestIdHeader,
      headers,
      raw: body,
      requiredScope,
    });
  }
  const Ctor = (BY_TYPE as Record<string, (new (init: NearPayErrorInit) => NearPayError) | undefined>)[env.type];
  return new (Ctor ?? NearPayError)({
    message: requiredScope ? `${env.message} (this restricted key needs the \`${requiredScope}\` scope)` : env.message,
    type: env.type,
    code: env.code,
    statusCode,
    param: env.param,
    docUrl: env.doc_url,
    requestId: env.request_id ?? requestIdHeader,
    headers,
    raw: body,
    requiredScope,
  });
}
