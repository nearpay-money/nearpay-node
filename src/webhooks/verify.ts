/**
 * Webhook signature verification (lld/sdks-and-tools.md §1, lld/webhooks.md §5–§6, api-conventions §9).
 *
 *   NearPay-Signature: t=<unix>,v1=<hex HMAC-SHA256>[,v1=<hex, previous secret>],v1a=<base64url Ed25519>,kid=<kid>
 *
 * Both signatures cover the UTF-8 bytes of `<t>.<raw body>`. Receivers must pass the raw body bytes
 * exactly as received (not re-serialised JSON). HMAC comparisons are constant-time; the timestamp
 * must be within the tolerance (300 s by default) of the receiver's clock.
 *
 * **Secret rotation** (`webhookEndpoints.rotateSecret`): during the overlap NearPay signs every
 * delivery with both the new and the previous secret (two `v1=`), so a receiver configured with
 * either secret verifies. Configure the new secret and keep the previous one with its expiry —
 * `[newSecret, {secret: oldSecret, expiresAt: endpoint.previous_secret_expires_at}]` — and both are
 * accepted until `expiresAt`, only the new one afterwards.
 *
 * The verified payload is parsed tolerantly into a `TypedEvent` (`data.object` typed by `type`);
 * events of types this SDK does not know yet are returned with their envelope checked.
 */
import { createHmac, createPublicKey, verify as cryptoVerify, timingSafeEqual } from "node:crypto";
import {
  Event,
  formatSignatureHeader,
  type ParsedSignatureHeader,
  parseSignatureHeader,
  type TypedEvent,
  WEBHOOK_TOLERANCE_SECONDS,
  type WebhookObjectOf,
  type WebhookType,
} from "@nearpay/spec";
import { NearPayResponseValidationError, NearPaySignatureVerificationError } from "../http/errors.js";
import { describeIssues, parseTolerantBody, type ResponseValidation, type ValidationIssue } from "../http/parse.js";

/** The object a webhook type carries (`payment_intent.succeeded` → PaymentIntent); the spec's `WebhookObjectOf`. */
export type WebhookObject<T extends WebhookType> = WebhookObjectOf<T>;

/**
 * A webhook event whose `data.object` is typed by `type` — the spec's `TypedEvent` (0.2.0).
 * Narrow with `if (event.type === "refund.succeeded") event.data.object.amount_received`.
 * New types may arrive without a new API version: keep a `default` branch.
 */
export type NearPayEvent = TypedEvent;

/** The raw request body as received: a string or the bytes (`Buffer`, `Uint8Array`). */
export type RawBody = string | Uint8Array;
/** A secret that stops being accepted at `expiresAt` (unix seconds; `previous_secret_expires_at`). */
export interface WebhookSecretEntry {
  readonly secret: string;
  readonly expiresAt?: number | null | undefined;
}
/** An endpoint signing secret (`whsec_…`), or several (during a rotation overlap any may match). */
export type WebhookSecret = string | WebhookSecretEntry | readonly (string | WebhookSecretEntry)[];

/** An Ed25519 public key of the JWKS at `GET /v1/webhook_signing_keys`. */
export interface WebhookSigningJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly kid: string;
  readonly alg?: string;
  readonly use?: string;
}
export type WebhookJwks = { readonly keys: readonly WebhookSigningJwk[] } | readonly WebhookSigningJwk[];

export interface VerifyOptions {
  /** Maximum age (and clock skew) of `t`, seconds; default 300. `0` disables the check (tests only). */
  readonly toleranceSec?: number;
  /** Current unix time in seconds (tests); default the system clock. */
  readonly now?: number;
  /**
   * How the verified payload is checked against the spec (`constructEvent` only): `"tolerant"`
   * (default; a payload that does not match is returned as parsed JSON and reported to
   * `onValidationIssue`), `"strict"` (throws `NearPayResponseValidationError`) or `"off"`.
   */
  readonly validation?: ResponseValidation;
  /** Called when the payload does not match the spec in `"tolerant"` mode. */
  readonly onValidationIssue?: (issues: readonly ValidationIssue[]) => void;
}

function bodyBytes(rawBody: unknown): Buffer {
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  throw new NearPaySignatureVerificationError(
    "rawBody must be the raw request body (string or Buffer) exactly as received, not parsed JSON",
  );
}

function headerValue(header: string | readonly string[] | null | undefined): string {
  const v = Array.isArray(header) ? header[0] : header;
  if (typeof v !== "string" || v.length === 0) {
    throw new NearPaySignatureVerificationError("missing NearPay-Signature header");
  }
  return v;
}

function parseAndCheckTime(
  header: string | readonly string[] | null | undefined,
  o: VerifyOptions,
): ParsedSignatureHeader {
  const parsed = parseSignatureHeader(headerValue(header));
  if (!parsed) throw new NearPaySignatureVerificationError("malformed NearPay-Signature header");
  const tolerance = o.toleranceSec ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (tolerance > 0 && Math.abs(now - parsed.timestamp) > tolerance) {
    throw new NearPaySignatureVerificationError(
      `signature timestamp ${parsed.timestamp} is outside the ${tolerance} s tolerance (now ${now})`,
    );
  }
  return parsed;
}

function secretsOf(secret: WebhookSecret, now: number): string[] {
  const list: readonly unknown[] = Array.isArray(secret) ? secret : [secret];
  const entries = list.map((s) => (typeof s === "string" ? { secret: s } : (s as WebhookSecretEntry | null)));
  if (entries.length === 0 || entries.some((e) => !e || typeof e.secret !== "string" || e.secret.length === 0)) {
    throw new NearPaySignatureVerificationError("a webhook signing secret (whsec_…) is required");
  }
  const live = (entries as WebhookSecretEntry[])
    .filter((e) => e.expiresAt === undefined || e.expiresAt === null || now <= e.expiresAt)
    .map((e) => e.secret);
  if (live.length === 0) throw new NearPaySignatureVerificationError("every configured webhook secret has expired");
  return live;
}

/** hex(HMAC-SHA256(key = UTF-8 secret incl. `whsec_`, msg = `<t>.` + raw body bytes)). */
export function computeV1Signature(secret: string, timestamp: number, rawBody: RawBody): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(`${timestamp}.`, "utf8"))
    .update(bodyBytes(rawBody))
    .digest("hex");
}

/**
 * Verifies the `v1` HMAC signature(s) and the timestamp, then returns the parsed event.
 * Throws `NearPaySignatureVerificationError` when the delivery must be rejected (answer 400).
 */
export function constructEvent(
  rawBody: RawBody,
  signatureHeader: string | readonly string[] | null | undefined,
  secret: WebhookSecret,
  options: VerifyOptions = {},
): NearPayEvent {
  const bytes = bodyBytes(rawBody);
  const secrets = secretsOf(secret, options.now ?? Math.floor(Date.now() / 1000));
  const parsed = parseAndCheckTime(signatureHeader, options);
  const candidates = parsed.v1.map((s) => Buffer.from(s, "hex"));
  let matched = false;
  for (const s of secrets) {
    const expected = Buffer.from(computeV1Signature(s, parsed.timestamp, bytes), "hex");
    // evaluate every candidate (no early exit on the secret loop's result)
    for (const c of candidates) if (c.length === expected.length && timingSafeEqual(c, expected)) matched = true;
  }
  if (!matched) throw new NearPaySignatureVerificationError("no v1 signature matches the expected signature");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new NearPaySignatureVerificationError("the signed payload is not valid JSON");
  }
  return parseEvent(json, options);
}

/**
 * Checks an event object (a verified webhook payload, or an event you stored) against the spec:
 * tolerant of new open-enum values and new event types (see `VerifyOptions.validation`).
 */
export function parseEvent(
  json: unknown,
  options: Pick<VerifyOptions, "validation" | "onValidationIssue"> = {},
): NearPayEvent {
  const mode = options.validation ?? "tolerant";
  if (mode === "off") return json as NearPayEvent;
  const outcome = parseTolerantBody(Event, json);
  if (outcome.ok) return outcome.data as NearPayEvent;
  if (mode === "strict") {
    throw new NearPayResponseValidationError({
      message: `the event does not match @nearpay/spec: ${describeIssues(outcome.issues)}`,
      raw: json,
      issues: outcome.issues,
    });
  }
  options.onValidationIssue?.(outcome.issues);
  return json as NearPayEvent;
}

function keysOf(jwks: WebhookJwks): readonly WebhookSigningJwk[] {
  const keys = Array.isArray(jwks) ? jwks : (jwks as { keys?: readonly WebhookSigningJwk[] }).keys;
  if (!Array.isArray(keys)) throw new NearPaySignatureVerificationError("jwks must be {keys: [...]} or an array");
  return keys.filter((k) => k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string");
}

/**
 * Verifies the `v1a` Ed25519 signature against the platform keys (`webhookSigningKeys.list()`),
 * selecting the key by `kid` when the header names one. Returns `true` or throws
 * `NearPaySignatureVerificationError`. Optional: `constructEvent` (HMAC) is sufficient on its own.
 */
export function verifyEd25519(
  rawBody: RawBody,
  signatureHeader: string | readonly string[] | null | undefined,
  jwks: WebhookJwks,
  options: VerifyOptions = {},
): true {
  const bytes = bodyBytes(rawBody);
  const parsed = parseAndCheckTime(signatureHeader, options);
  if (!parsed.v1a) throw new NearPaySignatureVerificationError("the header carries no v1a (Ed25519) signature");
  const signature = Buffer.from(parsed.v1a, "base64url");
  const all = keysOf(jwks);
  const keys = parsed.kid ? all.filter((k) => k.kid === parsed.kid) : all;
  if (keys.length === 0) {
    throw new NearPaySignatureVerificationError(
      parsed.kid ? `no Ed25519 signing key with kid ${parsed.kid}` : "no Ed25519 signing keys given",
    );
  }
  const message = Buffer.concat([Buffer.from(`${parsed.timestamp}.`, "utf8"), bytes]);
  for (const k of keys) {
    let ok = false;
    try {
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });
      ok = cryptoVerify(null, message, key, signature);
    } catch {
      ok = false;
    }
    if (ok) return true;
  }
  throw new NearPaySignatureVerificationError("the v1a signature does not verify with the signing keys");
}

/**
 * Builds a valid `NearPay-Signature` header for a payload (for your own webhook handler tests).
 * Pass several secrets to get one `v1=` per secret, as NearPay sends during a rotation overlap.
 */
export function generateTestHeaderString(o: {
  readonly payload: RawBody;
  readonly secret: string | readonly string[];
  readonly timestamp?: number;
}): string {
  const timestamp = o.timestamp ?? Math.floor(Date.now() / 1000);
  const secrets = typeof o.secret === "string" ? [o.secret] : [...o.secret];
  return formatSignatureHeader({ timestamp, v1: secrets.map((s) => computeV1Signature(s, timestamp, o.payload)) });
}

/** `nearpay.webhooks` (also usable without a client: `import { webhooks } from "@nearpay/node"`). */
export const webhooks = Object.freeze({
  constructEvent,
  parseEvent,
  verifyEd25519,
  generateTestHeaderString,
  computeV1Signature,
  DEFAULT_TOLERANCE_SECONDS: WEBHOOK_TOLERANCE_SECONDS,
});
export type Webhooks = typeof webhooks;
