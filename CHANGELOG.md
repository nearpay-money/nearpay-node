# Changelog

`@nearpay/node` follows semver. Breaking changes bump the major version and carry a migration note here.

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
