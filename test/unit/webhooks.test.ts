/**
 * Webhook verification against the shared vectors in `@nearpay-money/spec/test-vectors/webhook-signatures.json`
 * (lld/sdks-and-tools.md §6; the same file the webhooks signer is tested with).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { WEBHOOK_TYPES } from "@nearpay-money/spec";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  computeV1Signature,
  constructEvent,
  generateTestHeaderString,
  NearPay,
  NearPayResponseValidationError,
  NearPaySignatureVerificationError,
  parseEvent,
  type TypedEvent,
  verifyEd25519,
  webhooks,
} from "../../src/index.js";
import { event, invoice, publicReview, refund, subscription } from "../support/fixtures.js";

interface Vector {
  secret: string;
  secondary_secret: string;
  ed25519: { kid: string; seed_hex: string; public_key_base64url: string };
  timestamp: number;
  raw_body: string;
  signed_payload: string;
  header: string;
  header_during_rotation: string;
  negative: { reason: string; raw_body: string; header: string; now: number }[];
  verify_at: number;
}

const require = createRequire(import.meta.url);
const v = JSON.parse(
  readFileSync(require.resolve("@nearpay-money/spec/test-vectors/webhook-signatures.json"), "utf8"),
) as Vector;
const now = v.verify_at;
const jwks = {
  keys: [
    { kty: "OKP", crv: "Ed25519", x: v.ed25519.public_key_base64url, kid: v.ed25519.kid, alg: "EdDSA", use: "sig" },
  ],
};

const reject = (fn: () => unknown, msg: RegExp) => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(NearPaySignatureVerificationError);
  expect((err as Error).message).toMatch(msg);
  expect((err as NearPaySignatureVerificationError).code).toBe("signature_invalid");
};

describe("constructEvent (HMAC v1)", () => {
  it("verifies the vector header and returns the event", () => {
    const evt = constructEvent(v.raw_body, v.header, v.secret, { now });
    expect(evt.id).toBe("evt_01jbz9k3m4n5p6q7r8s9t0v1w2");
    expect(evt.type).toBe("payment_intent.succeeded");
  });

  it("computes the vector's v1 signature over the raw bytes (UTF-8, non-ASCII)", () => {
    const v1 = v.header.match(/v1=([0-9a-f]{64})/)?.[1];
    expect(computeV1Signature(v.secret, v.timestamp, v.raw_body)).toBe(v1);
    expect(computeV1Signature(v.secret, v.timestamp, Buffer.from(v.raw_body, "utf8"))).toBe(v1);
    expect(v.signed_payload).toBe(`${v.timestamp}.${v.raw_body}`);
  });

  it("accepts Buffer and Uint8Array bodies and a header given as an array", () => {
    const bytes = new TextEncoder().encode(v.raw_body);
    expect(constructEvent(Buffer.from(v.raw_body), v.header, v.secret, { now }).type).toBe("payment_intent.succeeded");
    expect(constructEvent(bytes, [v.header], v.secret, { now }).id).toBe("evt_01jbz9k3m4n5p6q7r8s9t0v1w2");
    const view = new Uint8Array(new ArrayBuffer(bytes.length + 4), 2, bytes.length);
    view.set(bytes);
    expect(constructEvent(view, v.header, v.secret, { now }).livemode).toBe(false);
  });

  it("accepts either secret during rotation (two v1 entries)", () => {
    expect(constructEvent(v.raw_body, v.header_during_rotation, v.secret, { now }).id).toBeDefined();
    expect(constructEvent(v.raw_body, v.header_during_rotation, v.secondary_secret, { now }).id).toBeDefined();
    expect(constructEvent(v.raw_body, v.header, [v.secondary_secret, v.secret], { now }).id).toBeDefined();
    reject(() => constructEvent(v.raw_body, v.header, v.secondary_secret, { now }), /no v1 signature matches/);
  });

  it.each(v.negative.map((n) => [n.reason, n] as const))("rejects the negative vector: %s", (_reason, n) => {
    expect(() => constructEvent(n.raw_body, n.header, v.secret, { now: n.now })).toThrow(
      NearPaySignatureVerificationError,
    );
  });

  it("enforces the tolerance in both directions, inclusive at 300 s", () => {
    expect(constructEvent(v.raw_body, v.header, v.secret, { now: v.timestamp + 300 }).id).toBeDefined();
    expect(constructEvent(v.raw_body, v.header, v.secret, { now: v.timestamp - 300 }).id).toBeDefined();
    reject(() => constructEvent(v.raw_body, v.header, v.secret, { now: v.timestamp + 301 }), /outside the 300 s/);
    reject(() => constructEvent(v.raw_body, v.header, v.secret, { now: v.timestamp - 301 }), /tolerance/);
    reject(
      () => constructEvent(v.raw_body, v.header, v.secret, { now: v.timestamp + 61, toleranceSec: 60 }),
      /outside the 60 s/,
    );
    expect(constructEvent(v.raw_body, v.header, v.secret, { now: 0, toleranceSec: 0 }).id).toBeDefined();
  });

  it("uses the system clock by default", () => {
    reject(() => constructEvent(v.raw_body, v.header, v.secret), /tolerance/);
    const header = generateTestHeaderString({ payload: v.raw_body, secret: v.secret });
    expect(constructEvent(v.raw_body, header, v.secret).id).toBeDefined();
  });

  it("rejects missing, empty and malformed headers", () => {
    reject(() => constructEvent(v.raw_body, undefined, v.secret, { now }), /missing/);
    reject(() => constructEvent(v.raw_body, "", v.secret, { now }), /missing/);
    reject(() => constructEvent(v.raw_body, [], v.secret, { now }), /missing/);
    reject(() => constructEvent(v.raw_body, null, v.secret, { now }), /missing/);
    reject(() => constructEvent(v.raw_body, "t=abc,v1=00", v.secret, { now }), /malformed/);
    reject(() => constructEvent(v.raw_body, `t=${v.timestamp}`, v.secret, { now }), /malformed/);
  });

  it("rejects parsed JSON instead of the raw body, and missing secrets", () => {
    reject(() => constructEvent(JSON.parse(v.raw_body) as never, v.header, v.secret, { now }), /raw request body/);
    reject(() => constructEvent(v.raw_body, v.header, "", { now }), /secret/);
    reject(() => constructEvent(v.raw_body, v.header, [], { now }), /secret/);
  });

  it("rejects a correctly signed body that is not JSON", () => {
    const header = generateTestHeaderString({ payload: "not json", secret: v.secret, timestamp: now });
    reject(() => constructEvent("not json", header, v.secret, { now }), /not valid JSON/);
  });

  it("round-trips generateTestHeaderString", () => {
    const header = generateTestHeaderString({ payload: v.raw_body, secret: v.secret, timestamp: v.timestamp });
    expect(header).toBe(`t=${v.timestamp},v1=${computeV1Signature(v.secret, v.timestamp, v.raw_body)}`);
    expect(constructEvent(v.raw_body, header, v.secret, { now }).id).toBeDefined();
  });
});

describe("verifyEd25519 (v1a)", () => {
  it("verifies the vector signature with the JWKS (by kid)", () => {
    expect(verifyEd25519(v.raw_body, v.header, jwks, { now })).toBe(true);
    expect(verifyEd25519(Buffer.from(v.raw_body), v.header_during_rotation, jwks.keys, { now })).toBe(true);
  });

  it("tries every key when the header names no kid", () => {
    const noKid = v.header.replace(/,kid=[^,]+/, "");
    const other = { ...jwks.keys[0], kid: "other", x: "A".repeat(43) } as (typeof jwks.keys)[number];
    expect(verifyEd25519(v.raw_body, noKid, { keys: [other, ...jwks.keys] }, { now })).toBe(true);
  });

  it("rejects a tampered body, an unknown kid, a missing v1a, a bad key and an old timestamp", () => {
    const bad = v.negative.find((n) => n.reason === "body changed");
    reject(() => verifyEd25519(bad?.raw_body ?? "", v.header, jwks, { now }), /does not verify/);
    reject(() => verifyEd25519(v.raw_body, v.header.replace("kid=wh-test-1", "kid=nope"), jwks, { now }), /kid nope/);
    reject(() => verifyEd25519(v.raw_body, v.header.replace(/,v1a=[^,]+/, ""), jwks, { now }), /no v1a/);
    reject(
      () => verifyEd25519(v.raw_body, v.header, { keys: [{ ...jwks.keys[0], x: "AAAA" } as never] }, { now }),
      /does not verify/,
    );
    reject(() => verifyEd25519(v.raw_body, v.header.replace(/,kid=[^,]+/, ""), { keys: [] }, { now }), /no Ed25519/);
    reject(() => verifyEd25519(v.raw_body, v.header, jwks, { now: v.timestamp + 400 }), /tolerance/);
    reject(() => verifyEd25519(v.raw_body, v.header, { nope: 1 } as never, { now }), /jwks must be/);
  });

  it("ignores non-Ed25519 keys", () => {
    const rsa = { kty: "RSA", crv: "", x: "", kid: v.ed25519.kid };
    reject(() => verifyEd25519(v.raw_body, v.header, [rsa], { now }), /no Ed25519 signing key with kid/);
  });
});

describe("namespace", () => {
  it("is exposed standalone and on the client", () => {
    const np = new NearPay("sk_test_abc");
    expect(np.webhooks).toBe(webhooks);
    expect(webhooks.DEFAULT_TOLERANCE_SECONDS).toBe(300);
    expect(np.webhooks.constructEvent(v.raw_body, v.header, v.secret, { now }).id).toBeDefined();
  });
});

describe("event typing", () => {
  it("narrows data.object by type", () => {
    const evt = constructEvent(v.raw_body, v.header, v.secret, { now });
    if (evt.type === "payment_intent.succeeded") {
      expectTypeOf(evt.data.object.id).toEqualTypeOf<`pi_${string}`>();
    }
    if (evt.type === "ping") expectTypeOf(evt.data.object.webhook_endpoint).toEqualTypeOf<`we_${string}`>();
    expect(evt.data.object.id).toBe("pi_01jbz9k3m4n5p6q7r8s9t0v1w2");
  });

  it("types sequence (spec 0.1.5) on checkout session and agent payment objects", () => {
    const evt = constructEvent(v.raw_body, v.header, v.secret, { now });
    if (evt.type === "checkout.session.completed") {
      expectTypeOf(evt.data.object.sequence).toEqualTypeOf<number | undefined>();
    }
    if (evt.type === "agent_payment.settled") {
      expectTypeOf(evt.data.object.sequence).toEqualTypeOf<number | undefined>();
    }
  });
});

describe("open enums (api-conventions §5)", () => {
  it("returns unknown event types and open-enum values verbatim (tolerant parsing)", () => {
    const payload = JSON.stringify({
      id: "evt_01jbz9k3m4n5p6q7r8s9t0v1w9",
      object: "event",
      type: "payment_intent.teleported",
      api_version: "2026-11-01",
      created: v.timestamp,
      livemode: false,
      data: {
        object: { id: "pi_01jbz9k3m4n5p6q7r8s9t0v1w2", object: "payment_intent", status: "levitating", sequence: 7 },
      },
      request: { id: null, idempotency_key: null },
    });
    const header = generateTestHeaderString({ payload, secret: v.secret, timestamp: v.timestamp });
    const evt = constructEvent(payload, header, v.secret, { now });
    expect(evt.type as string).toBe("payment_intent.teleported");
    expect(evt.data.object).toMatchObject({ status: "levitating", sequence: 7 });
  });
});

describe("secret rotation overlap (webhookEndpoints.rotateSecret)", () => {
  const rotationHeader = v.header_during_rotation;

  it("the vector's rotation header verifies with the new secret alone, the previous alone, or both", () => {
    for (const secrets of [[v.secret], [v.secondary_secret], [v.secret, v.secondary_secret]]) {
      expect(constructEvent(v.raw_body, rotationHeader, secrets, { now }).id).toBeDefined();
    }
  });

  it("accepts the previous secret until its expiry and refuses it afterwards", () => {
    const previous = { secret: v.secondary_secret, expiresAt: now + 60 };
    // a receiver that holds only the previous secret: valid inside the window
    expect(constructEvent(v.raw_body, rotationHeader, [previous], { now }).id).toBeDefined();
    expect(constructEvent(v.raw_body, rotationHeader, [previous], { now: now + 60, toleranceSec: 0 }).id).toBeDefined();
    expect(() => constructEvent(v.raw_body, rotationHeader, [previous], { now: now + 61, toleranceSec: 0 })).toThrow(
      /expired/,
    );
    // after the window, a delivery signed only with the new secret verifies with [new, previous]
    const later = now + 3600;
    const header = generateTestHeaderString({ payload: v.raw_body, secret: v.secret, timestamp: later });
    expect(constructEvent(v.raw_body, header, [v.secret, previous], { now: later }).id).toBeDefined();
    // and a delivery forged with the expired previous secret is refused
    const forged = generateTestHeaderString({ payload: v.raw_body, secret: v.secondary_secret, timestamp: later });
    expect(() => constructEvent(v.raw_body, forged, [v.secret, previous], { now: later })).toThrow(
      NearPaySignatureVerificationError,
    );
  });

  it("takes entries without expiry, a single entry, and refuses empty entries", () => {
    expect(constructEvent(v.raw_body, v.header, { secret: v.secret }, { now }).id).toBeDefined();
    expect(constructEvent(v.raw_body, v.header, [{ secret: v.secret, expiresAt: null }], { now }).id).toBeDefined();
    expect(() => constructEvent(v.raw_body, v.header, [{ secret: "" }], { now })).toThrow(/secret/);
    expect(() => constructEvent(v.raw_body, v.header, [null as never], { now })).toThrow(/secret/);
  });

  it("generateTestHeaderString signs with several secrets like a rotation delivery", () => {
    const h = generateTestHeaderString({
      payload: v.raw_body,
      secret: [v.secret, v.secondary_secret],
      timestamp: v.timestamp,
    });
    expect(h).toBe(rotationHeader.replace(/,v1a=.*$/, ""));
  });
});

describe("typed events and tolerant parsing of verified payloads", () => {
  const sign = (payload: string) => generateTestHeaderString({ payload, secret: v.secret, timestamp: now });

  it("returns a spec-valid refund event parsed and typed (TypedEvent)", () => {
    const payload = JSON.stringify(event("refund.succeeded", refund({ status: "succeeded" })));
    const evt = constructEvent(payload, sign(payload), v.secret, { now, validation: "strict" });
    expectTypeOf(evt).toEqualTypeOf<TypedEvent>();
    if (evt.type === "refund.succeeded") {
      expectTypeOf(evt.data.object.amount_received).toEqualTypeOf<string | null>();
      expect(evt.data.object.object).toBe("refund");
    } else throw new Error("expected a refund event");
  });

  it("types review events with PublicReview", () => {
    const payload = JSON.stringify(event("review.opened", publicReview()));
    const evt = constructEvent(payload, sign(payload), v.secret, { now, validation: "strict" });
    if (evt.type === "review.opened") expectTypeOf(evt.data.object.subject.type).toBeString();
    expect(evt.type).toBe("review.opened");
  });

  it("strict validation throws on a payload that breaks the spec; tolerant reports it; off skips", () => {
    const payload = JSON.stringify({ ...event("refund.succeeded", refund()), created: "yesterday" });
    expect(() => constructEvent(payload, sign(payload), v.secret, { now, validation: "strict" })).toThrow(
      NearPayResponseValidationError,
    );
    const seen: unknown[] = [];
    const evt = constructEvent(payload, sign(payload), v.secret, { now, onValidationIssue: (i) => seen.push(...i) });
    expect(evt.created as unknown).toBe("yesterday");
    expect(seen).toHaveLength(1);
    expect(constructEvent(payload, sign(payload), v.secret, { now, validation: "off" }).created as unknown).toBe(
      "yesterday",
    );
  });

  it("verifies and types the 12 billing event types of spec 0.3.0 (invoice.*, customer.subscription.*)", () => {
    const billing = Object.keys(WEBHOOK_TYPES).filter(
      (t) => t.startsWith("invoice.") || t.startsWith("customer.subscription."),
    );
    expect(billing.sort()).toEqual(
      [
        "invoice.created",
        "invoice.finalized",
        "invoice.sent",
        "invoice.paid",
        "invoice.payment_failed",
        "invoice.overdue",
        "invoice.voided",
        "invoice.marked_uncollectible",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "customer.subscription.renewal_upcoming",
      ].sort(),
    );
    for (const type of billing) {
      // events carry hosted_invoice_url: null (secrets never travel on the bus)
      const object = type.startsWith("invoice.")
        ? invoice({ status: "open", hosted_invoice_url: null })
        : subscription();
      const payload = JSON.stringify(event(type, object));
      const evt = constructEvent(payload, sign(payload), v.secret, { now, validation: "strict" });
      expect(evt.type, type).toBe(type);
      expect((evt.data.object as { object: string }).object).toBe(
        type.startsWith("invoice.") ? "invoice" : "subscription",
      );
    }
    const payload = JSON.stringify(event("invoice.paid", invoice({ status: "paid", hosted_invoice_url: null })));
    const evt = constructEvent(payload, sign(payload), v.secret, { now });
    if (evt.type === "invoice.paid") {
      expectTypeOf(evt.data.object.amount_paid).toEqualTypeOf<string | number>();
      expectTypeOf(evt.data.object.sequence).toBeNumber();
    }
    const sub = JSON.stringify(event("customer.subscription.renewal_upcoming", subscription()));
    const e2 = constructEvent(sub, sign(sub), v.secret, { now });
    if (e2.type === "customer.subscription.renewal_upcoming")
      expectTypeOf(e2.data.object.current_period_end).toBeNumber();
    expect(e2.type).toBe("customer.subscription.renewal_upcoming");
  });

  it("parseEvent checks stored events (unknown types tolerated)", () => {
    const stored = {
      ...event("ping", { object: "ping", webhook_endpoint: "we_01jbz9k3m4n5p6q7r8s9t0v1w2" }),
      type: "brand.new",
    };
    expect(webhooks.parseEvent(stored, { validation: "strict" }).type as string).toBe("brand.new");
    expect(parseEvent(JSON.parse(v.raw_body)).id).toBe("evt_01jbz9k3m4n5p6q7r8s9t0v1w2");
  });
});
