# nearpay-node

> Server SDK for Node/TypeScript: typed resources, automatic idempotency keys and retries, webhook signature verification, refund signing helpers.

|                                       |                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Group                                 | SDKs & tools                                                                                  |
| Kind                                  | library                                                                                       |
| Ships as                              | npm: @nearpay/node                                                                            |
| Owns                                  | Public SDK                                                                                    |
| Depends on (published artifacts only) | spec (public)                                                                                 |
| First built in                        | Stage 1 (step 1.3); full in Stage 2 (step 2.3); billing + events stream in Stage 3 (step 3.3) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/sdks-and-tools.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/sdks-and-tools.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/api-conventions.md`

## Usage

```ts
import { NearPay, NearPayError, NearPaySignatureVerificationError } from "@nearpay/node";

const nearpay = new NearPay(process.env.NEARPAY_SECRET_KEY!, {
  baseUrl: "https://api.nearpay.localhost", // default https://api.nearpay.money
});

// POSTs (and idempotent PATCHes) carry an automatic Idempotency-Key (UUIDv4) reused across the
// SDK's own retries; pass your own to make a retry of *your* request safe too.
const session = await nearpay.checkout.sessions.create(
  { amount: 200, currency: "usd", success_url: "https://shop.example/thanks", customer: "cus_…" },
  { idempotencyKey: `order-${orderId}` },
);
redirect(session.url);

// Custom payer UI: a headless intent; its client_secret is returned once (give it to @nearpay/js).
const { client_secret } = await nearpay.paymentIntents.create({ amount: 4999, currency: "usd", return_url });

// Lists: await one page, or iterate every page (cursor pagination, filters kept). ADR-0018 filters:
// ranges flat ("created[gte]") or grouped, metadata[key] filters as an object.
for await (const pi of nearpay.paymentIntents.list({
  status: "succeeded",
  created: { gte: since },
  amount: { gte: "1000" },
  metadata: { order_id: "42" },
})) {
  console.log(pi.id, pi.amount_settled);
}
const last50 = await nearpay.refunds.list({ payment_intent: pi.id }).autoPagingToArray({ limit: 50 });

// Webhooks: verify the raw body bytes exactly as received.
try {
  const event = nearpay.webhooks.constructEvent(rawBody, req.headers["nearpay-signature"], process.env.NEARPAY_WEBHOOK_SECRET!);
  switch (event.type) {
    case "payment_intent.succeeded": fulfil(event.data.object.id); break; // data.object typed by `type`
    case "refund.succeeded": notify(event.data.object.amount_received); break;
    default: break; // new types arrive without a new API version
  }
} catch (e) {
  if (e instanceof NearPaySignatureVerificationError) return res.status(400).end();
  throw e;
}
```

### Billing: invoices and subscriptions

```ts
const product = await nearpay.products.create({ name: "Pro plan" });
const monthly = await nearpay.prices.create({
  product: product.id,
  unit_amount: 4900,
  currency: "usd",
  recurring: { interval: "month" },
});
const vat = await nearpay.taxRates.create({ display_name: "VAT", percentage: "19", inclusive: false, country: "DE" });

// One-off invoice: draft → finalize (number, due date, hosted URL, PDF) → send (emails the customer)
const draft = await nearpay.invoices.create({
  customer: "cus_…",
  lines: [{ unit_amount: 25000, description: "Onboarding workshop" }],
  currency: "usd",
  default_tax_rates: [vat.id],
  days_until_due: 14,
});
const invoice = await nearpay.invoices.finalize(draft.id);
await nearpay.invoices.send(invoice.id);
console.log(invoice.hosted_invoice_url); // https://pay…/i/in_…#<invoice secret> — share only with the customer
await writeFile(`${invoice.number}.pdf`, await nearpay.invoices.pdf(invoice.id)); // Uint8Array (+ .filename)

// Subscription: every period is invoiced in advance and emailed (collection_method: send_invoice)
const sub = await nearpay.subscriptions.create({
  customer: "cus_…",
  items: [{ price: monthly.id }],
  trial_period_days: 14,
  dunning: { reminder_days: [-3, 0, 3, 7], on_exhausted: "cancel" },
});
await nearpay.subscriptions.cancel(sub.id, { at_period_end: true });
```

Invoices are paid by the customer on the hosted invoice page (non-custodial: the payment settles to your
settlement destination). There is no "mark paid out of band" (INV-2); `void` and `markUncollectible`
close an invoice instead. Automatic debit of subscriptions arrives with Stage 4 vault mandates.

### Live events in development (`events.stream`)

```ts
// Test-mode keys only (a live key gets 403 livemode_forbidden). Not signed, not retried: use webhooks
// for production fulfilment; the stream is for tools, local development and tests.
const stream = nearpay.events.stream(
  { types: ["invoice.paid", "customer.subscription.deleted"] },
  {
    onReset: (r) => console.warn(`resume cursor ${r.cursor} ${r.reason}; list missed events with events.list()`),
  },
);
for await (const event of stream) {
  if (event.type === "invoice.paid") console.log("paid", event.data.object.number);
}
```

The iterator reconnects after the server's 1 h close, dropped or silent connections (no heartbeat for
45 s), 429 and 5xx (backoff 1 s → 30 s, `Retry-After` honoured) and resumes with `Last-Event-ID`, so no
event is skipped; duplicates (delivery is at-least-once) are dropped. `starting_after` replays from an
event (30-day retention). Errors a retry cannot fix (400, 401, 403) end the loop by throwing;
`stream.close()` or `signal` stop it. The `@nearpay/cli` `nearpay listen` command is built on the same API.

### Test helpers

```ts
const session = await nearpay.checkout.sessions.create({ amount: 200, currency: "usd", success_url });
await nearpay.testHelpers.checkoutSessions.pay(session.id, { outcome: "succeeded" }); // sandbox; events follow
```

### Resources

| Resource                 | Methods (spec route)                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.sessions`      | `create`, `retrieve(id, {expand})`, `list`, `expire(id)`                                                                                                                  |
| `paymentIntents`         | `create` (headless, returns `client_secret`), `retrieve`, `list` (ADR-0018 filters + `metadata`), `cancel`, `review(id, {decision})`                                      |
| `refunds`                | `create`, `retrieve`, `list`, `prepare(id)`, `submitTx(id, {tx_hash} \| {signed_intent})`, `cancel(id)`; `signers` (below)                                                |
| `paymentLinks`           | `create`, `retrieve`, `list({active})`, `update` (no delete: deactivate)                                                                                                  |
| `customers`              | `create`, `retrieve`, `list({email})`, `update`, `del`                                                                                                                    |
| `products`               | `create`, `retrieve`, `list({active})`, `update` (no delete: archive with `active: false`)                                                                                |
| `prices`                 | `create` (one-time or `recurring`; fiat minor units or asset base units), `retrieve`, `list`, `update` (`active`, `nickname`, `metadata`)                                 |
| `taxRates`               | `create` (decimal-string `percentage`, `inclusive`), `retrieve`, `list`, `update`                                                                                         |
| `invoices`               | `create` (draft), `retrieve`, `list` (status, customer, subscription, due date), `update`, `del` (drafts), `finalize`, `send`, `void`, `markUncollectible`, `pdf` (bytes) |
| `subscriptions`          | `create` (items, trial, dunning), `retrieve`, `list`, `update` (from the next renewal), `cancel(id, {at_period_end})`                                                     |
| `balanceTransactions`    | `list` (incl. `refund` filter)                                                                                                                                            |
| `settlementDestinations` | `retrieve(id)`, `list`                                                                                                                                                    |
| `webhookEndpoints`       | `create`, `retrieve`, `list`, `update`, `del`, `test`, `listDeliveries`, `rotateSecret(id, {expire_previous_in_seconds})`                                                 |
| `events`                 | `retrieve(id)`, `list`, `resend(id, {endpoint?})`, `stream({types, starting_after}, options)` (async iterator, test-mode keys)                                            |
| `webhookSigningKeys`     | `list` (JWKS for `verifyEd25519`)                                                                                                                                         |
| `agentPayments`          | `retrieve(id)`, `list`                                                                                                                                                    |
| `x402`                   | `supported`, `requirements`, `verify`, `settle`; `nearIntents.{requirements, verify, settle}` (cross-chain)                                                               |
| `assets`                 | `list`                                                                                                                                                                    |
| `testHelpers`            | `paymentAttempts.advance(attemptId, {to})`, `refunds.simulateDeposit(refundId)`, `checkoutSessions.pay(sessionId, {outcome})` (test mode)                                 |

Every method is bound from a route of `@nearpay/spec` 0.3.0 (`src/resources/routes.ts`); arguments and
results are typed from the route's zod schemas. Shape: `(pathParam?, bodyOrQuery?, options?)` where
`options` is `{idempotencyKey?, timeoutMs?, maxRetries?, signal?, apiVersion?}`. Results carry a
non-enumerable `lastResponse` (`requestId`, `idempotencyKey`, `idempotentReplayed`, `attempts`, headers,
`unknownEnumValues`, `validationIssues`). List methods return a `ListPromise`: `await` → one page;
`for await` → every item; `autoPagingToArray({limit})`, `autoPagingEach(fn)` (return `false` to stop).

**Not in the SDK** (the spec allows only a dashboard session for them): API keys (incl. restricted keys),
account, KYB, team and invitations, settlement-destination writes, CLI login approval, and
`refunds/{id}/recipient` (owner + step-up, INV-7). Payer routes (`client_secret`, payment-link `…/public`,
hosted-invoice `/v1/invoices/{id}/public/**` with the invoice secret) belong to `@nearpay/js`, the
hosted pages and `@nearpay/mcp`.

**Restricted keys** (`rk_…`, created in the dashboard) work like secret keys for the methods their scopes
allow: `restrictedKeyScope("refunds.create")` → `"refunds.write"`, `scopesFor([...methods])` lists what a
least-privilege key needs, and a `403` carries `error.requiredScope`.

### Refund signing (`nearpay.refunds.signers`)

NearPay never holds your funds: a refund leg's `next_action` is what **you** sign with the wallet behind
the settlement destination; NearPay only relays it. The helpers sign exactly that payload, after checking
that it encodes the one transfer the action displays (receiver, asset, amount, memo, deadline), that an
`intents_transfer` refund goes to the payer's recorded account, that the current leg is unsubmitted and
its amount matches, and that the deadline is ahead — they never build another recipient or amount.

```ts
// Intents-account destination (`sign_intent`): a NEAR KeyPair (NEP-413 / raw ed25519) or a viem Account (ERC-191)
const signer = nearpay.refunds.signers.nearKeyPair(KeyPair.fromString(process.env.NEAR_PRIVATE_KEY!));
// const signer = nearpay.refunds.signers.evmAccount(privateKeyToAccount(process.env.EVM_KEY!));
await nearpay.refunds.signers.signAndSubmit(refund.id, signer);

// Chain-address destination (`sign_and_send`): a viem WalletClient (native / ERC-20), or your own sender
await nearpay.refunds.signers.signAndSubmit(refund.id, nearpay.refunds.signers.evmWallet(walletClient));
await nearpay.refunds.signers.signAndSubmit(refund.id, { send: async (t) => ({ txHash: await mySend(t) }) });
```

Also: `check(refund)` (validation only), `signIntent(refund, signer)` → `{signed_intent}`,
`chainTransfer(action)`, `evmTransferRequest(transfer)`. Refusals are `NearPayRefundSigningError` (`code`:
`no_action`, `already_submitted`, `payload_mismatch`, `recipient_mismatch`, `deadline_passed`,
`signer_mismatch`, `wrong_signer`, `unsupported_chain`). `submit_failed` means the transfer **was
broadcast** but reporting it failed: do not send again; report `error.txHash` with `refunds.submitTx`.
No runtime dependency: signers are structural (`{sign, getPublicKey}`, `{address, signMessage}`,
`{account, getChainId, sendTransaction}`). Named NEAR accounts and ERC-191 signatures are verified by
NearPay and the Verifier before relaying (implicit-account keys and ed25519 signatures are checked locally).

### Transport, retries, parsing

- Per-attempt timeout 30 s; `NearPay-Version` pinned per client (default: the spec's current version).
- Up to 2 retries with exponential backoff and jitter, `Retry-After` honoured up to the 8 s cap — only
  where repeating cannot apply a request twice (api-conventions §4–§6): 429 and 409
  `idempotency_in_progress` (not processed) and connections refused before sending, always; 5xx,
  timeouts, dropped connections and cut-off bodies only for GET, DELETE and routes that honour the
  Idempotency-Key. Catalogue codes marked non-retryable (`too_many_attempts`) are never retried; the
  x402 facilitator POSTs (not idempotent) are not repeated after the server may have acted — except
  `x402.verify`, which changes nothing and is repeated like a GET. `x402.settle` is idempotent on the
  payload, but a repeat after an unknown outcome answers `replayed: true` (which a paywall must treat as
  "already delivered"), so the SDK leaves that decision to you.
- `invoices.pdf` resolves with the PDF bytes (`Uint8Array`, `filename`, `contentType`, `lastResponse`);
  errors are JSON as usual.
- Responses are parsed with the spec schemas via `safeParseTolerant`: new open-enum values and new event
  types are kept (listed in `lastResponse.unknownEnumValues`). `responseValidation` decides what happens
  to a body that breaks the contract: `"tolerant"` (default) returns it as received and reports it
  (`lastResponse.validationIssues`, `onValidationIssue`, else one process warning per route); `"strict"`
  throws `NearPayResponseValidationError` (with the `idempotencyKey` for a replay-safe retry); `"off"`.

**Errors:** every failure is a `NearPayError` subclass by envelope `type` — `NearPayInvalidRequestError`,
`NearPayAuthenticationError`, `NearPayPermissionError`, `NearPayPaymentError`, `NearPayIdempotencyError`,
`NearPayStateConflictError`, `NearPayRateLimitError`, `NearPayApiError`, `NearPayRailUnavailableError` —
plus `NearPayConnectionError` (no response; `timedOut`), `NearPayResponseValidationError`,
`NearPaySignatureVerificationError` and `NearPayRefundSigningError`. Each has `code` (`e.is("amount_exceeds_refundable")`),
`statusCode`, `param`, `docUrl`, `requestId`, `retryable` (from the error catalogue) and `requiredScope`.

**Webhooks:** `constructEvent(rawBody, header, secrets, {toleranceSec = 300, validation})` verifies any of
the `v1` HMACs (constant-time) and returns a `TypedEvent`. **Secret rotation:** after
`webhookEndpoints.rotateSecret`, NearPay signs with both secrets until `previous_secret_expires_at`;
configure `[newSecret, {secret: oldSecret, expiresAt: endpoint.previous_secret_expires_at}]` and both are
accepted in the window, only the new one afterwards. `verifyEd25519(rawBody, header, jwks)` verifies
`v1a` against `webhookSigningKeys.list()`; `parseEvent(json)` checks a stored event;
`generateTestHeaderString({payload, secret | secrets})` signs payloads for your own tests (several secrets
= a rotation delivery). All work without a client: `import { webhooks } from "@nearpay/node"`.

More: `examples/checkout.ts`, `examples/refund.ts`, `examples/webhook-server.ts`, `examples/invoice.ts`,
`examples/listen.ts`.

## Install (local registry)

Until public registries exist, `@nearpay/*` packages come from the local Verdaccio (`nearpay-deploy`):

```
@nearpay:registry=http://127.0.0.1:4873/
```

`zod` (^4.6.7) is a peer dependency (required by `@nearpay/spec`; npm and pnpm install it automatically).

## Development

```
pnpm install
pnpm verify          # typecheck + Biome + unit tests (coverage ≥ 90% branches) + contract tests + build
NP_REGISTRY_PASSWORD=$(cat ../nearpay-deploy/.secrets/registry_password) pnpm release:local   # publish to 127.0.0.1:4873
```

- `test/unit` — every resource method against `test/support/spec-mock.ts`, an in-process mock that
  checks credentials, headers, Idempotency-Key, params/query/body strictly against the spec routes, replays
  stored idempotent responses and validates its own answers against the response schemas; transport
  against a scripted HTTP server (retry policy per route kind, key reuse, timeouts, aborts); tolerant
  parsing; auto-pagination; refund signers against `@nearpay/spec/test-vectors/intents-payloads.json`;
  webhook verification (incl. rotation) against `webhook-signatures.json`; resource tree vs
  `PUBLIC_ROUTES` (a new key-callable route fails the build until bound).
- `test/contract` — every bound route called through a minimal gateway into the spec-driven service mocks
  (`mockPeer`), which validate requests strictly and responses against the spec.
- `scripts/release-local.mjs` publishes a reproducible tarball to the loopback registry only (refuses any
  other registry); an already published identical version is skipped.

## Status

0.3.0 (Stage 3, step 3.3): `lld/sdks-and-tools.md` §1 for `@nearpay/spec` 0.3.0 — billing (products,
prices, tax rates, invoices with PDF, subscriptions), the events stream, cross-chain x402 and the checkout
test helper. Stage 4: subscription auto-debit (vault mandates).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.

- Runtime: `@nearpay/spec` (contracts), `zod` (peer, via the spec); Node's built-in `fetch` and `crypto`
  (HMAC-SHA256, Ed25519, `timingSafeEqual`).
- Development: TypeScript, Vitest (+ coverage-v8), Biome, `@nearpay-internal/testing` (spec-driven mocks),
  `@noble/curves` + `@noble/hashes` (test-only: an ERC-191 signer for the spec vectors).
