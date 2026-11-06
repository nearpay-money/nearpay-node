/**
 * Webhook signature verification (lld/sdks-and-tools.md §1, lld/webhooks.md §6, api-conventions §9).
 *
 *   NearPay-Signature: t=<unix>,v1=<hex HMAC-SHA256>[,v1=<hex, secondary secret>],v1a=<base64url Ed25519>,kid=<kid>
 *
 * Both signatures cover the UTF-8 bytes of `<t>.<raw body>`. Receivers must pass the raw body bytes
 * exactly as received (not re-serialised JSON). HMAC comparisons are constant-time; the timestamp
 * must be within the tolerance (300 s by default) of the receiver's clock.
 */
import { createHmac, createPublicKey, verify as cryptoVerify, timingSafeEqual } from "node:crypto";
import {
  type Event,
  formatSignatureHeader,
  type ParsedSignatureHeader,
  parseSignatureHeader,
  WEBHOOK_TOLERANCE_SECONDS,
  type WEBHOOK_TYPES,
  type WebhookType,
} from "@nearpay/spec";
import type { z } from "zod";
import { NearPaySignatureVerificationError } from "../http/errors.js";

/** The object a webhook type carries (`payment_intent.succeeded` → PaymentIntent), from `WEBHOOK_TYPES`. */
export type WebhookObject<T extends WebhookType> = z.output<(typeof WEBHOOK_TYPES)[T]["object"]>;

/**
 * A webhook event whose `data.object` is typed by `type` (the spec's `Event` types it as `unknown`).
 * Narrow with `if (event.type === "payment_intent.succeeded") event.data.object.amount_settled`.
 * New types may arrive without a new API version: handle unknown `type`s gracefully.
 */
export type NearPayEvent = {
  [T in WebhookType]: Omit<Event, "type" | "data"> & {
    readonly type: T;
    readonly data: { readonly object: WebhookObject<T>; readonly previous_attributes?: Record<string, unknown> };
  };
}[WebhookType];

/** The raw request body as received: a string or the bytes (`Buffer`, `Uint8Array`). */
export type RawBody = string | Uint8Array;
/** An endpoint signing secret (`whsec_…`), or several (during rotation any may match). */
export type WebhookSecret = string | readonly string[];

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

function secretsOf(secret: WebhookSecret): string[] {
  const list = typeof secret === "string" ? [secret] : [...secret];
  if (list.length === 0 || list.some((s) => typeof s !== "string" || s.length === 0)) {
    throw new NearPaySignatureVerificationError("a webhook signing secret (whsec_…) is required");
  }
  return list;
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
  const secrets = secretsOf(secret);
  const parsed = parseAndCheckTime(signatureHeader, options);
  const candidates = parsed.v1.map((s) => Buffer.from(s, "hex"));
  let matched = false;
  for (const s of secrets) {
    const expected = Buffer.from(computeV1Signature(s, parsed.timestamp, bytes), "hex");
    // evaluate every candidate (no early exit on the secret loop's result)
    for (const c of candidates) if (c.length === expected.length && timingSafeEqual(c, expected)) matched = true;
  }
  if (!matched) throw new NearPaySignatureVerificationError("no v1 signature matches the expected signature");
  try {
    return JSON.parse(bytes.toString("utf8")) as NearPayEvent;
  } catch {
    throw new NearPaySignatureVerificationError("the signed payload is not valid JSON");
  }
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

/** Builds a valid `NearPay-Signature` header for a payload (for your own webhook handler tests). */
export function generateTestHeaderString(o: {
  readonly payload: RawBody;
  readonly secret: string;
  readonly timestamp?: number;
}): string {
  const timestamp = o.timestamp ?? Math.floor(Date.now() / 1000);
  return formatSignatureHeader({ timestamp, v1: [computeV1Signature(o.secret, timestamp, o.payload)] });
}

/** `nearpay.webhooks` (also usable without a client: `import { webhooks } from "@nearpay/node"`). */
export const webhooks = Object.freeze({
  constructEvent,
  verifyEd25519,
  generateTestHeaderString,
  computeV1Signature,
  DEFAULT_TOLERANCE_SECONDS: WEBHOOK_TOLERANCE_SECONDS,
});
export type Webhooks = typeof webhooks;
