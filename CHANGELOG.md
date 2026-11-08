# Changelog

`@nearpay/node` follows semver. Breaking changes bump the major version and carry a migration note here.

## 0.3.0 — Stage 3, step 3.3 (`@nearpay/spec` 0.3.0)

Minor release: Stage 3 resources and helpers. **No breaking API change** — every 0.2 method, option,
type and export keeps its name and shape.

Added:

- Billing: `products`, `prices`, `taxRates` (`create`, `retrieve`, `list`, `update`); `invoices`
  (`create`, `retrieve`, `list`, `update`, `del`, `finalize`, `send`, `void`, `markUncollectible`,
  `pdf`); `subscriptions` (`create`, `retrieve`, `list`, `update`, `cancel`). Types `Invoice`,
  `InvoiceLineItem`, `DeletedInvoice`, `Product`, `Price`, `TaxRate`, `Subscription`,
  `SubscriptionItem`; the spec's normative tax arithmetic is re-exported (`computeLineTax`,
  `computeInvoiceTotals`, `taxPercentageToPpm`) for previews that match NearPay's rounding.
- `invoices.pdf(id)` resolves with the PDF **bytes** (`BinaryResult`: a `Uint8Array` with `filename` from
  `Content-Disposition`, `contentType` and `lastResponse`). The transport now handles spec routes with a
  `binaryResponse` (`Accept: application/pdf, application/json`; errors stay JSON; a 200 with another
  content type is a contract violation reported per `responseValidation`).
- `events.stream(params?, options?)` — `GET /v1/events/stream` as an async iterator (`EventStream`):
  typed `TypedEvent`s, `onReady` / `onReset` / `onReconnect`, `lastEventId`, `close()`, `signal`.
  Reconnects after the server's 1 h close, dropped or silent connections (`idleTimeoutMs`, default 45 s),
  429 and 5xx (backoff 1 s → 30 s with jitter, `Retry-After` honoured; the server's `retry:` after a
  clean close) and resumes with `Last-Event-ID`; drops duplicate ids; forgets a cursor the server
  `reset`; ends by throwing on 400/401/403 (`livemode_forbidden`: API keys stream test mode only).
  Frames are parsed tolerantly like responses (`validation`, `onValidationIssue`). `SseParser` exported.
- Webhooks: `constructEvent` / `parseEvent` verify and type the 12 billing event types (`invoice.*`,
  `customer.subscription.*`) — they come from the spec's `WEBHOOK_TYPES`, no SDK change needed beyond the
  spec bump; tests cover every type.
- Cross-chain x402: `x402.nearIntents.{requirements, verify, settle}` (not idempotent: never repeated
  after a 5xx/timeout).
- Test helper: `testHelpers.checkoutSessions.pay(id, {outcome?, origin_asset_id?, amount_in?})` (behind
  `nearpay trigger`).
- Restricted keys: every key-callable route of spec 0.3.0 has a restricted-key scope, including the
  sandbox helpers (`checkout_sessions.write`, `refunds.write`); `scopesFor` covers the new methods.

Changed (safer, no API change):

- **`x402.verify` is retried** after a 5xx, timeout or dropped connection like a GET (it changes no state;
  node CR "x402Verify/x402Settle idempotent", answered in the spec 0.2.1 notes). `x402.settle` stays
  un-retried: a repeat after an unknown outcome answers `replayed: true`, which a paywall must treat as
  "already delivered", and the SDK cannot tell its own earlier attempt from another request's.

Known issue (spec CR filed for 0.3.1): the spec's `TypedEvent` is built with `Omit` over the loose
`Event` schema, so the envelope fields (`id`, `created`, `livemode`, …) are typed `unknown`; `type` and
`data.object` narrow correctly. Use `stream.lastEventId` or `String(event.id)` until the spec fix.

Not bound: hosted-invoice payer routes (`/v1/invoices/{id}/public/**`, invoice secret — hosted page and
`@nearpay/mcp`), CLI login (`/v1/cli/logins*`, anonymous device flow and dashboard approval — `@nearpay/cli`).

## 0.2.0 — Stage 2, step 2.3 (`@nearpay/spec` 0.2.0)

Minor release: new resources and helpers. **No breaking API change** — every 0.1 method, option, type
and export keeps its name and shape. Two behaviour changes, both safer and both listed here:

- **Retries follow api-conventions §4–§6 per route.** 429, 409 `idempotency_in_progress` and connections
  refused before sending are retried for every route; 5xx, timeouts, dropped connections and cut-off
  bodies only for replay-safe routes (GET, DELETE, routes that honour the Idempotency-Key). The x402
  facilitator POSTs (`x402.requirements/verify/settle`, `idempotent: false` in the spec) are no longer
  repeated after a 5xx or timeout. Catalogue codes marked `retryable: false` (e.g. `too_many_attempts`)
  are no longer retried.
- **Responses are parsed tolerantly** with the spec schemas (`safeParseTolerant`; design change of
  LLD §1, lead decision for 2.3). Spec-conforming responses come back as before (plus schema defaults);
  unknown open-enum values and event types are kept. A response that breaks the contract is still
  returned as received in the default `responseValidation: "tolerant"` mode, but is reported (once per
  route as a `NearPayWarning` process warning unless you pass `onValidationIssue`). Opt out with
  `responseValidation: "off"`; opt in to throwing with `"strict"`.

Added:

- Resources: `paymentIntents.create` (headless, `CreatedPaymentIntent` with `client_secret`) and
  `review`; `refunds` (`create`, `retrieve`, `list`, `prepare`, `submitTx`, `cancel`); `paymentLinks`
  (`create`, `retrieve`, `list`, `update`); `customers` (`create`, `retrieve`, `list`, `update`, `del`);
  `webhookEndpoints.rotateSecret`; `events.resend`; `testHelpers.refunds.simulateDeposit`.
- `refunds.signers`: `check`, `signIntent`, `signAndSubmit`, `nearKeyPair` (NEP-413 / raw ed25519),
  `evmAccount` (ERC-191, normalised v/low-s), `evmWallet` (native / ERC-20), `chainTransfer`,
  `evmTransferRequest`; `NearPayRefundSigningError` (incl. `submit_failed` with `txHash`). They sign only
  the API's `next_action` after checking it encodes the displayed transfer (never another recipient or
  amount). No runtime dependency (structural signers; base58, NEP-413 hashing and calldata built in).
- Auto-pagination: list methods return a `ListPromise` (`await` = first page, `for await`,
  `autoPagingToArray({limit})`, `autoPagingEach`), forward or backward (`ending_before`).
- List queries: grouped range filters (`created: {gte}`, `amount: {lt}`) next to the flat keys, and
  `metadata: {key: value}` for routes with `metadata[key]` filters (ADR-0018); nested objects encode as
  `key[sub]=value`.
- Webhooks: `constructEvent` returns the spec's `TypedEvent` (`NearPayEvent` is now an alias of it);
  secrets may be `{secret, expiresAt}` entries for the rotation overlap; `parseEvent`;
  `generateTestHeaderString` takes several secrets; `validation` / `onValidationIssue` options.
- Errors: `retryable` (error catalogue), `requiredScope` (403 of a restricted key), `is(code)`,
  `NearPayResponseValidationError`. `lastResponse.unknownEnumValues` / `validationIssues`.
- Restricted keys: `restrictedKeyScope`, `scopesFor`, `methodAccess`.
- Types: `Refund`, `RefundNextAction`, `PaymentLink`, `Customer`, `DeletedCustomer`,
  `CreatedPaymentIntent`, `EventResend`, `WebhookEndpoint`, `PublicReview`, `Account`, `TypedEvent`,
  `EventDataObject`, `WebhookObjectOf`, `MultiPayload`, `ListPromise`, …

Not bound (session-only in the spec): API keys, account, KYB, team/invitations, settlement-destination
writes, `updateRefundRecipient`. Payer routes stay with `@nearpay/js`.

## 0.1.x unreleased — Stage 1, step 1.4 (`@nearpay/spec` 0.1.5; shipped in 0.2.0)

- `webhookEndpoints.listDeliveries(id, {limit?, starting_after?, ending_before?})` — an endpoint's
  delivery log (`GET /v1/webhook_endpoints/{id}/deliveries`, cursor list of `WebhookDelivery`).
- `WebhookDelivery` type export; `sequence` on `CheckoutSession` / `AgentPayment` (and their webhook
  objects) and x402 `SettleResponse.replayed` come typed from the spec.
- Not bound: `getDashboardSession` and `challengeSettlementDestination` (session-only dashboard routes).
- Responses were still returned as received (no response validation); superseded by tolerant parsing in 0.2.0.

## 0.1.0 — Stage 1, step 1.3

First release (Stage 1 subset of `nearpay-brain/lld/sdks-and-tools.md` §1), built on `@nearpay/spec` 0.1.4:

- Resource clients bound from the spec route tables: `checkout.sessions` (create, retrieve, list, expire),
  `paymentIntents` (retrieve, list, cancel), `balanceTransactions.list`, `settlementDestinations`
  (retrieve, list), `webhookEndpoints` (create, retrieve, list, update, del, test), `events` (retrieve,
  list), `webhookSigningKeys.list`, `agentPayments` (retrieve, list), `x402` (supported, requirements,
  verify, settle), `assets.list`, `testHelpers.paymentAttempts.advance`.
- Transport: 30 s per-attempt timeout, automatic UUIDv4 `Idempotency-Key` on POST (and PATCH) reused across
  up to 2 retries (network errors, 409 `idempotency_in_progress`, 429, 5xx) with exponential backoff and
  jitter, `Retry-After` honoured, `NearPay-Version` pinned per client, `lastResponse` metadata.
- `webhooks.constructEvent` (HMAC `v1`, any of several signatures and secrets, constant-time, 300 s
  tolerance), `webhooks.verifyEd25519` (`v1a` against the JWKS, by `kid`), `generateTestHeaderString`.
- Typed errors: one `NearPayError` subclass per error `type`, with `code`, `statusCode` and `requestId`.

Not yet: refunds and `refunds.signers`, payment links, customers (Stage 2); billing resources (Stage 3).
