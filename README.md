# nearpay-node

> Server SDK for Node/TypeScript: typed resources, automatic idempotency keys and retries, webhook signature verification, refund signing helpers.

| | |
|---|---|
| Group | SDKs & tools |
| Kind | library |
| Ships as | npm: @nearpay/node |
| Owns | Public SDK |
| Depends on (published artifacts only) | spec (public) |
| Roadmap phase | P1 Core payments |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/api-conventions.md`

## Layout

```
nearpay-node/
├── examples/
├── src/
│   ├── http/
│   ├── resources/
│   ├── signing/
│   └── webhooks/
├── test/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in phase **P1 Core payments** (`nearpay-brain/roadmap/roadmap.md`).
