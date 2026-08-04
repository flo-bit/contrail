# Contrail development

> Pre-alpha. Expect breaking changes.

## Layout

Contrail now has one package and one implementation:

```text
packages/contrail/
  src/core/       ingestion, storage, queries, hydration
  src/adapters/   SQLite and PostgreSQL adapters
  src/worker/     Cloudflare Worker helper
  src/cli/        operational commands
```

Reference deployments live under `apps/`:

- `cloudflare-workers` — minimal Worker + D1;
- `postgres` — minimal Node.js + PostgreSQL; and
- `sveltekit-cloudflare-workers` — SvelteKit + D1.

## Setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Focused commands:

```bash
pnpm --filter @atmo-dev/contrail build
pnpm --filter @atmo-dev/contrail test
pnpm --filter contrail-cloudflare-workers-example dev
```

## Releasing

Changesets version and publish `@atmo-dev/contrail`:

```bash
pnpm changeset
pnpm changeset version
pnpm release
```
