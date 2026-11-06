# nearpay-node

> Server SDK for Node/TypeScript: typed resources, automatic idempotency keys and retries, webhook signature verification, refund signing helpers.

|                                       |                    |
| ------------------------------------- | ------------------ |
| Group                                 | SDKs & tools       |
| Kind                                  | library            |
| Ships as                              | npm: @nearpay/node |
| Owns                                  | Public SDK         |
| Depends on (published artifacts only) | spec (public)      |
| First built in                        | Stage 1 (step 1.3) |

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

// POSTs carry an automatic Idempotency-Key (UUIDv4) reused across the SDK's own retries;
// pass your own to make a retry of *your* request safe too.
const session = await nearpay.checkout.sessions.create(
  { amount: 200, currency: "usd", success_url: "https://shop.example/thanks" },
  { idempotencyKey: `order-${orderId}` },
);
redirect(session.url);

// Webhooks: verify the raw body bytes exactly as received.
try {
  const event = nearpay.webhooks.constructEvent(rawBody, req.headers["nearpay-signature"], process.env.NEARPAY_WEBHOOK_SECRET!);
  if (event.type === "payment_intent.succeeded") fulfil(event.data.object.id); // typed by `type`
} catch (e) {
  if (e instanceof NearPaySignatureVerificationError) return res.status(400).end();
  throw e;
}
```

| Resource                      | Methods (spec route)                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| `checkout.sessions`           | `create`, `retrieve(id, {expand})`, `list`, `expire(id)`                |
| `paymentIntents`              | `retrieve(id)`, `list`, `cancel(id, {cancellation_reason})`             |
| `balanceTransactions`         | `list`                                                                  |
| `settlementDestinations`      | `retrieve(id)`, `list`                                                  |
| `webhookEndpoints`            | `create`, `retrieve`, `list`, `update`, `del`, `test`, `listDeliveries` |
| `events`                      | `retrieve(id)`, `list`                                                  |
| `webhookSigningKeys`          | `list` (JWKS for `verifyEd25519`)                                       |
| `agentPayments`               | `retrieve(id)`, `list`                                                  |
| `x402`                        | `supported`, `requirements`, `verify`, `settle`                         |
| `assets`                      | `list`                                                                  |
| `testHelpers.paymentAttempts` | `advance(attemptId, {to})` (test mode)                                  |

Every method is bound from a route of `@nearpay/spec` (`src/resources/routes.ts`); arguments and results
are typed from the route's zod schemas. Shape: `(pathParam?, bodyOrQuery?, options?)` where `options` is
`{idempotencyKey?, timeoutMs?, maxRetries?, signal?, apiVersion?}`. Results carry a non-enumerable
`lastResponse` (`requestId`, `idempotentReplayed`, `attempts`, headers).

**Transport** (LLD §1): per-attempt timeout 30 s; up to 2 retries on network errors, 409
`idempotency_in_progress`, 429 and 5xx with exponential backoff and jitter (honouring `Retry-After`);
`NearPay-Version` pinned per client (default: the spec's current version).

**Errors:** every failure is a `NearPayError` subclass by envelope `type` — `NearPayInvalidRequestError`,
`NearPayAuthenticationError`, `NearPayPermissionError`, `NearPayPaymentError`, `NearPayIdempotencyError`,
`NearPayStateConflictError`, `NearPayRateLimitError`, `NearPayApiError`, `NearPayRailUnavailableError` —
plus `NearPayConnectionError` (no response; `timedOut`) and `NearPaySignatureVerificationError`. Each has
`code`, `statusCode`, `param`, `docUrl` and `requestId`.

**Webhooks:** `constructEvent(rawBody, header, secret | secrets[], {toleranceSec = 300})` verifies any of
the `v1` HMACs (constant-time; several secrets during rotation); `verifyEd25519(rawBody, header, jwks)`
verifies `v1a` against `webhookSigningKeys.list()`; `generateTestHeaderString({payload, secret})` signs
payloads for your own tests. Both work without a client: `import { webhooks } from "@nearpay/node"`.

More: `examples/checkout.ts`, `examples/webhook-server.ts`.

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

- `test/unit` — transport against a scripted local HTTP server (retries, idempotency-key reuse, timeouts,
  aborts), typed errors, resource tree vs `PUBLIC_ROUTES` (a new key-callable Stage 1 route fails the
  build until bound), webhook verification against `@nearpay/spec/test-vectors/webhook-signatures.json`.
- `test/contract` — every bound route called through a minimal gateway into the spec-driven service mocks
  (`mockPeer`), which validate requests strictly and responses against the spec.
- `scripts/release-local.mjs` publishes a reproducible tarball to the loopback registry only (refuses any
  other registry); an already published identical version is skipped.

## Status

Stage 1 subset done (step 1.3): resources above, transport, webhooks, typed errors. Stage 2: refunds with
`refunds.signers`, payment links, customers; Stage 3: billing resources.

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.

- Runtime: `@nearpay/spec` (contracts), `zod` (peer, via the spec); Node's built-in `fetch` and `crypto`
  (HMAC-SHA256, Ed25519, `timingSafeEqual`).
- Development: TypeScript, Vitest (+ coverage-v8), Biome, `@nearpay-internal/testing` (spec-driven mocks).
