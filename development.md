# Development

> Pre-alpha. Expect breaking changes.

## Workspace layout

- `packages/contrail/` — `@atmo-dev/contrail` (core, adapters, Cloudflare Worker helper, CLI)
- `packages/contrail-spaces-alpha/` — workspace-private Spaces extension
- `apps/cloudflare-workers/` — minimal Worker + D1 example
- `apps/sqlite/` — minimal Node + SQLite + Alluvium example
- `apps/postgres/` — minimal Node + PostgreSQL example
- `apps/benchmark/` — backfill benchmarks and D1 row-cost guardrails

## Commands

Requires Node.js >= 22.15 (Node 24 recommended for SQLite FTS5) and pnpm.

```bash
pnpm install
pnpm typecheck          # typecheck all packages, tests, and example apps
pnpm build              # build packages/*
pnpm test               # unit tests (SQLite + Spaces)
pnpm test:postgres      # PostgreSQL tests via in-process PGlite
pnpm test:built         # smoke tests against built dist/ entrypoints
pnpm test:workerd       # Cloudflare workerd + local D1 smoke tests
pnpm test:cost          # cost-harness unit tests
pnpm bench:cost:ci      # local D1 row-cost ceiling checks
```

## Releasing

Uses Changesets for `@atmo-dev/contrail`:

```bash
pnpm changeset
pnpm changeset version
pnpm release
```
