# Contrail

> **Work in progress!** Pre-alpha, expect breaking changes.

Contrail is a library (and a small set of sibling packages) for building AT Protocol appviews. Define collections, get automatic Jetstream ingestion, PDS backfill, typed XRPC endpoints, permissioned spaces for private records, group-controlled communities, and a client-side reactive sync layer.

## Packages

| Package | Description |
|---|---|
| [`@atmo-dev/contrail`](./packages/contrail) | Core library — indexing, XRPC server, spaces, communities, realtime publishing. |
| [`@atmo-dev/contrail-sync`](./packages/sync) | Client-side reactive watch-store over `watchRecords`. SSE + WebSocket, IndexedDB cache. |
| [`@atmo-dev/contrail-lexicons`](./packages/lexicons) | Lexicon codegen from a Contrail config + CLI (`contrail-lex`) wrapping `@atcute/lex-cli`. |

## Apps (reference deployments — `workspace:*`-linked)

| App | Description |
|---|---|
| [`rsvp-atmo`](./apps/rsvp-atmo) | Cloudflare Workers + D1 indexer for `community.lexicon.calendar.*`. |
| [`group-chat`](./apps/group-chat) | Full-featured SvelteKit + Workers group chat using spaces, communities, and realtime. |
| [`postgres`](./apps/postgres) | Node + PostgreSQL minimal indexer. |
| [`cloudflare-workers`](./apps/cloudflare-workers) | Minimal Worker example. |
| [`sveltekit-cloudflare-workers`](./apps/sveltekit-cloudflare-workers) | SvelteKit Statusphere-style example. |

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Per-package commands run through Turbo:

```bash
pnpm build           # turbo run build
pnpm typecheck       # turbo run typecheck
pnpm test            # turbo run test
pnpm --filter @atmo-dev/contrail build
pnpm --filter rsvp-atmo dev
```

## Releasing

Changesets drive versioning. `@atmo-dev/contrail` and `@atmo-dev/contrail-sync` are `linked` so their versions stay aligned (they share the realtime wire protocol).

```bash
pnpm changeset              # add a changeset
pnpm changeset version      # bump versions
pnpm release                # build + publish
```
