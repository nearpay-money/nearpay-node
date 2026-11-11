/**
 * Spec-valid objects for tests: every builder parses its result with the spec schema, so a fixture
 * cannot drift from `@nearpay-money/spec`. Stage 1 objects come from `@nearpay-internal/testing`.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { paymentIntent, USDC_NEAR } from "@nearpay-internal/testing";
import {
  API_VERSION,
  CreatedPaymentIntent,
  Customer,
  DeletedCustomer,
  DeletedInvoice,
  Event,
  EventResend,
  EventStreamReady,
  EventStreamReset,
  Invoice,
  PaymentLink,
  Price,
  Product,
  PublicReview,
  Refund,
  Subscription,
  TaxRate,
  TestHelperPayment,
  WebhookDelivery,
  WebhookEndpoint,
} from "@nearpay-money/spec";
import { base58Encode } from "../../src/signing/encoding.js";
import type { NearKeyPairLike, RefundSignIntentAction } from "../../src/signing/refunds.js";

export { USDC_NEAR };
export const USDC_BASE_ASSET = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const USDC_BASE_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const require = createRequire(import.meta.url);
export const intentsVectors = JSON.parse(
  readFileSync(require.resolve("@nearpay-money/spec/test-vectors/intents-payloads.json"), "utf8"),
) as {
  nonce_base64: string;
  binding: string;
  nep413: { seed_hex: string; signer_id: string; hash_hex: string; multipayload: Record<string, unknown> };
  erc191: { private_key_hex: string; address: string; hash_hex: string; multipayload: Record<string, unknown> };
  raw_ed25519: { seed_hex: string; signer_id: string; multipayload: Record<string, unknown> };
};
export const webhookVectors = JSON.parse(
  readFileSync(require.resolve("@nearpay-money/spec/test-vectors/webhook-signatures.json"), "utf8"),
) as {
  secret: string;
  secondary_secret: string;
  timestamp: number;
  raw_body: string;
  header: string;
  header_during_rotation: string;
  ed25519: { kid: string; seed_hex: string; public_key_base64url: string };
  negative: { reason: string; raw_body?: string; header: string; secret?: string; now?: number }[];
  verify_at?: number;
};

export const now = () => Math.floor(Date.now() / 1000);
export const ids = {
  cs: "cs_01jbz9k3m4n5p6q7r8s9t0v1w2",
  pi: "pi_01jbz9k3m4n5p6q7r8s9t0v1w2",
  pa: "pa_01jbz9k3m4n5p6q7r8s9t0v1w2",
  re: "re_01jbz9k3m4n5p6q7r8s9t0v1w2",
  plink: "plink_01jbz9k3m4n5p6q7r8s9t0v1w2",
  cus: "cus_01jbz9k3m4n5p6q7r8s9t0v1w2",
  we: "we_01jbz9k3m4n5p6q7r8s9t0v1w2",
  evt: "evt_01jbz9k3m4n5p6q7r8s9t0v1w2",
  whd: "whd_01jbz9k3m4n5p6q7r8s9t0v1w2",
  sd: "sd_01jbz9k3m4n5p6q7r8s9t0v1w2",
  // stage 3 — billing
  prod: "prod_01jbz9k3m4n5p6q7r8s9t0v1w2",
  price: "price_01jbz9k3m4n5p6q7r8s9t0v1w2",
  txr: "txr_01jbz9k3m4n5p6q7r8s9t0v1w2",
  in: "in_01jbz9k3m4n5p6q7r8s9t0v1w2",
  il: "il_01jbz9k3m4n5p6q7r8s9t0v1w2",
  sub: "sub_01jbz9k3m4n5p6q7r8s9t0v1w2",
  si: "si_01jbz9k3m4n5p6q7r8s9t0v1w2",
  acct: "acct_01jbz9k3m4n5p6q7r8s9t0v1w2",
} as const;
/** `prefix_` + 26 base32 chars, distinct per `n`. */
export const idN = (prefix: string, n: number) => `${prefix}_01jbz9k3m4n5p6q7r8s9t${n.toString(32).padStart(5, "0")}`;

export const page = <T>(url: string, data: T[], has_more = false) => ({
  object: "list" as const,
  data,
  has_more,
  url,
});

// ------------------------------------------------------------------------------------------ keys

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** An ed25519 key from a 32-byte seed: node KeyObjects plus a `near-api-js`-shaped key pair. */
export function ed25519FromSeed(seedHex: string) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const x = createPublicKey(privateKey).export({ format: "jwk" }).x as string;
  const publicKey = Buffer.from(x, "base64url");
  const keyPair: NearKeyPairLike = {
    sign: (message) => ({ signature: Uint8Array.from(cryptoSign(null, message, privateKey)) }),
    getPublicKey: () => ({ toString: () => `ed25519:${base58Encode(publicKey)}` }),
  };
  return { privateKey, publicKey, publicKeyHex: publicKey.toString("hex"), x, keyPair };
}

// ------------------------------------------------------------------------------------- objects

export function customer(over: Partial<Customer> = {}): Customer {
  return Customer.parse({
    id: ids.cus,
    object: "customer",
    created: now(),
    livemode: false,
    email: "ada@example.com",
    name: "Ada",
    description: null,
    wallets: [{ chain: "near:mainnet", address: "ada.near" }],
    metadata: {},
    ...over,
  });
}

export function deletedCustomer() {
  return DeletedCustomer.parse({ id: ids.cus, object: "customer", livemode: false, deleted: true });
}

export function paymentLink(over: Partial<PaymentLink> = {}): PaymentLink {
  return PaymentLink.parse({
    id: ids.plink,
    object: "payment_link",
    created: now(),
    livemode: false,
    active: true,
    url: `https://pay.nearpay.localhost/l/${ids.plink}`,
    amount: 2500,
    currency: "usd",
    asset_id: null,
    description: "T-shirt",
    settlement_destination: null,
    success_url: null,
    session_expires_in: 3600,
    max_uses: null,
    uses: 0,
    collect_email: true,
    metadata: {},
    ...over,
  });
}

export function createdPaymentIntent() {
  return CreatedPaymentIntent.parse({
    ...paymentIntent(),
    checkout_session: ids.cs,
    client_secret: `${ids.cs}_secret_${"a1B2".repeat(8)}`,
  });
}

export function webhookEndpoint(over: Record<string, unknown> = {}) {
  return WebhookEndpoint.parse({
    id: ids.we,
    object: "webhook_endpoint",
    created: now(),
    livemode: false,
    url: "https://merchant.example/webhooks",
    enabled_events: ["refund.succeeded"],
    api_version: API_VERSION,
    description: null,
    status: "enabled",
    disabled_reason: null,
    ...over,
  });
}

export function delivery(over: Record<string, unknown> = {}) {
  return WebhookDelivery.parse({
    id: ids.whd,
    object: "webhook_delivery",
    created: now(),
    livemode: false,
    webhook_endpoint: ids.we,
    event: ids.evt,
    event_type: "refund.succeeded",
    status: "pending",
    attempts: 0,
    last_status_code: null,
    last_error: null,
    next_attempt_at: now(),
    succeeded_at: null,
    ...over,
  });
}

export function eventResend() {
  return EventResend.parse({ object: "event_resend", event: ids.evt, deliveries: [delivery()] });
}

export function event(type: string, object: unknown, over: Record<string, unknown> = {}) {
  return Event.parse({
    id: ids.evt,
    object: "event",
    type,
    api_version: API_VERSION,
    created: now(),
    livemode: false,
    data: { object },
    request: { id: null, idempotency_key: null },
    ...over,
  });
}

export function publicReview(status: "open" | "closed" = "open") {
  return PublicReview.parse({
    id: "case_01jbz9k3m4n5p6q7r8s9t0v1w2",
    object: "review",
    created: now(),
    livemode: false,
    subject: { type: "payment_intent", id: ids.pi },
    reason: "held_execution",
    status,
    closed_at: status === "closed" ? now() : null,
  });
}

// ------------------------------------------------------------------------------------- refunds

export const PAYER = "payer.near";

/** A `sign_intent` next action that encodes exactly one transfer (what payments builds). */
export function signIntentAction(o: {
  signerId: string;
  receiver?: string;
  amount?: string;
  deadline?: number;
  standards?: ("nep413" | "erc191" | "raw_ed25519")[];
}): RefundSignIntentAction & { message: { intents: Record<string, unknown>[] } } {
  const deadline = o.deadline ?? now() + 600;
  const transfer = {
    receiver_id: o.receiver ?? PAYER,
    token: USDC_NEAR,
    amount: o.amount ?? "2000000",
    memo: intentsVectors.binding,
  };
  const intents = [
    {
      intent: "transfer" as const,
      receiver_id: transfer.receiver_id,
      tokens: { [transfer.token]: transfer.amount },
      memo: transfer.memo,
    },
  ];
  const message = {
    signer_id: o.signerId,
    verifying_contract: "intents.near" as const,
    deadline: new Date(deadline * 1000).toISOString(),
    nonce: intentsVectors.nonce_base64,
    intents,
  };
  return {
    type: "sign_intent" as const,
    signer_id: o.signerId,
    transfer,
    standards: o.standards ?? ["nep413", "raw_ed25519"],
    nep413: {
      recipient: "intents.near" as const,
      nonce: intentsVectors.nonce_base64,
      message: JSON.stringify({ signer_id: message.signer_id, deadline: message.deadline, intents }),
    },
    payload: JSON.stringify(message),
    message,
    deadline,
    display: `Transfer 2.000000 USDC to ${transfer.receiver_id}`,
  };
}

export function signAndSendAction(
  o: { amount?: string; deadline?: number; native?: boolean; memo?: string | null } = {},
) {
  return {
    type: "sign_and_send" as const,
    chain: "eip155:8453",
    from: "0x42e06263bb5346ae6421ab1ec1019824e7b284e1",
    to: "0x1111111111111111111111111111111111111111",
    asset_id: USDC_BASE_ASSET,
    token: o.native ? { standard: "native", address: null } : { standard: "erc20", address: USDC_BASE_TOKEN },
    symbol: "USDC",
    decimals: 6,
    amount: o.amount ?? "2000000",
    memo: o.memo ?? null,
    deadline: o.deadline ?? now() + 600,
    display: "Send 2.000000 USDC on Base to 0x1111…1111",
  };
}

export function refund(over: Record<string, unknown> & { next_action?: unknown } = {}): Refund {
  const action = (over.next_action ?? null) as { type: string; amount?: string; transfer?: { amount: string } } | null;
  const amount = action ? (action.type === "sign_intent" ? action.transfer?.amount : action.amount) : "2000000";
  const asset = action?.type === "sign_and_send" ? USDC_BASE_ASSET : USDC_NEAR;
  return Refund.parse({
    id: ids.re,
    object: "refund",
    created: now(),
    livemode: false,
    status: action ? "requires_action" : "pending",
    payment_intent: ids.pi,
    payment_attempt: ids.pa,
    amount: amount ?? "2000000",
    asset_id: asset,
    decimals: 6,
    fee_mode: "payer_absorbs",
    reason: "requested_by_customer",
    method: action?.type === "sign_and_send" ? "route_quote" : "intents_transfer",
    recipient: {
      address: action?.type === "sign_and_send" ? "0x2222222222222222222222222222222222222222" : PAYER,
      asset_id: asset,
      chain: action?.type === "sign_and_send" ? "eip155:8453" : "near:mainnet",
      type: action?.type === "sign_and_send" ? "origin_chain" : "intents",
      overridden: false,
    },
    next_action: action,
    legs: [
      {
        number: 1,
        status: "awaiting_signature",
        method: action?.type === "sign_and_send" ? "route_quote" : "intents_transfer",
        swap_type: action?.type === "sign_and_send" ? "EXACT_INPUT" : null,
        amount: amount ?? "2000000",
        amount_out_expected: null,
        deadline: now() + 600,
        submitted_tx: null,
        duplicate: false,
        evidence: null,
        failure_code: null,
        created: now(),
      },
    ],
    amount_received: null,
    evidence: null,
    extra_amount_sent: "0",
    source: "api",
    failure_code: null,
    succeeded_at: null,
    canceled_at: null,
    sequence: 1,
    metadata: {},
    ...over,
  });
}

// ------------------------------------------------------------------------------- stage 3 billing

export function product(over: Record<string, unknown> = {}) {
  return Product.parse({
    id: ids.prod,
    object: "product",
    created: now(),
    updated: now(),
    livemode: false,
    name: "Pro plan",
    description: null,
    active: true,
    metadata: {},
    ...over,
  });
}

export function price(over: Record<string, unknown> = {}) {
  return Price.parse({
    id: ids.price,
    object: "price",
    created: now(),
    livemode: false,
    product: ids.prod,
    active: true,
    type: "recurring",
    unit_amount: 4900,
    currency: "usd",
    asset_id: null,
    recurring: { interval: "month", interval_count: 1 },
    nickname: null,
    metadata: {},
    ...over,
  });
}

export function taxRate(over: Record<string, unknown> = {}) {
  return TaxRate.parse({
    id: ids.txr,
    object: "tax_rate",
    created: now(),
    livemode: false,
    display_name: "VAT",
    description: null,
    jurisdiction: "DE",
    country: "DE",
    percentage: "19",
    rate_ppm: 190_000,
    inclusive: false,
    active: true,
    metadata: {},
    ...over,
  });
}

/** A one-line USD invoice: 49.00 + 19 % VAT = 58.31. `status: "open"` adds number, URL and due date. */
export function invoice(over: Record<string, unknown> = {}) {
  const open = (over.status ?? "draft") !== "draft";
  const tax = {
    tax_rate: ids.txr,
    display_name: "VAT",
    percentage: "19",
    inclusive: false,
    amount: 931,
    taxable_amount: 4900,
  };
  return Invoice.parse({
    id: ids.in,
    object: "invoice",
    created: now(),
    livemode: false,
    status: "draft",
    number: open ? "INV-00042" : null,
    customer: ids.cus,
    subscription: null,
    billing_reason: "manual",
    collection_method: "send_invoice",
    currency: "usd",
    asset_id: null,
    description: null,
    footer: null,
    lines: [
      {
        id: ids.il,
        object: "line_item",
        type: "invoiceitem",
        price: ids.price,
        product: ids.prod,
        subscription_item: null,
        description: "Pro plan",
        quantity: 1,
        unit_amount: 4900,
        amount: 4900,
        amount_excluding_tax: 4900,
        tax_rates: [ids.txr],
        tax_amounts: [tax],
        period: null,
      },
    ],
    default_tax_rates: [],
    subtotal: 4900,
    tax: 931,
    total: 5831,
    total_excluding_tax: 4900,
    total_tax_amounts: [tax],
    amount_due: 5831,
    amount_paid: 0,
    amount_remaining: 5831,
    days_until_due: 30,
    due_date: open ? now() + 30 * 86_400 : null,
    period_start: null,
    period_end: null,
    settlement_destination: null,
    reminder_days: [-3, 0, 1, 3, 7],
    reminders_sent: 0,
    next_reminder_at: null,
    hosted_invoice_url: open ? `https://pay.nearpay.money/i/${ids.in}#${ids.in}_secret_${"A".repeat(32)}` : null,
    invoice_pdf: open ? `https://api.nearpay.money/v1/invoices/${ids.in}/pdf` : null,
    checkout_session: null,
    payment_intent: null,
    payment_intents: [],
    status_transitions: {
      finalized_at: open ? now() : null,
      sent_at: null,
      paid_at: null,
      voided_at: null,
      marked_uncollectible_at: null,
    },
    uncollectible_reason: null,
    metadata: {},
    sequence: 0,
    ...over,
  });
}

export function deletedInvoice() {
  return DeletedInvoice.parse({ id: ids.in, object: "invoice", livemode: false, deleted: true });
}

export function subscription(over: Record<string, unknown> = {}) {
  const t = now();
  return Subscription.parse({
    id: ids.sub,
    object: "subscription",
    created: t,
    livemode: false,
    customer: ids.cus,
    status: "active",
    collection_method: "send_invoice",
    items: [{ id: ids.si, object: "subscription_item", price: price(), quantity: 1, tax_rates: null }],
    currency: "usd",
    asset_id: null,
    recurring: { interval: "month", interval_count: 1 },
    billing_cycle_anchor: t,
    current_period_start: t,
    current_period_end: t + 30 * 86_400,
    days_until_due: 7,
    default_tax_rates: [],
    dunning: { reminder_days: [-3, 0, 1, 3, 7], on_exhausted: "cancel" },
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    cancellation_reason: null,
    latest_invoice: ids.in,
    settlement_destination: null,
    description: null,
    metadata: {},
    sequence: 0,
    ...over,
  });
}

export function testHelperPayment(outcome = "succeeded") {
  return TestHelperPayment.parse({
    object: "test_helper_payment",
    checkout_session: ids.cs,
    payment_intent: ids.pi,
    payment_attempt: ids.pa,
    outcome,
  });
}

export function streamReady(over: Record<string, unknown> = {}) {
  return EventStreamReady.parse({
    object: "event_stream",
    livemode: false,
    account: ids.acct,
    types: ["*"],
    resumed_after: null,
    expires_at: now() + 3600,
    ...over,
  });
}

export function streamReset(cursor: string, reason = "cursor_expired") {
  return EventStreamReset.parse({ object: "event_stream_reset", reason, cursor });
}
