/**
 * Webhook verification against the shared vectors in `@nearpay/spec/test-vectors/webhook-signatures.json`
 * (lld/sdks-and-tools.md §6; the same file the webhooks signer is tested with).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  computeV1Signature,
  constructEvent,
  generateTestHeaderString,
  NearPay,
  NearPaySignatureVerificationError,
  verifyEd25519,
  webhooks,
} from "../../src/index.js";

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
  readFileSync(require.resolve("@nearpay/spec/test-vectors/webhook-signatures.json"), "utf8"),
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
  it("returns unknown event types and open-enum values verbatim (no response validation, LLD §1)", () => {
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
