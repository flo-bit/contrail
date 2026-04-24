# Contrail

> **pre-alpha.** Expect breaking changes.

a library for easily creating (serverless) atproto backends/appviews.

- declare collections
- get automatic jetstream backfill and ingestion, typed XRPC endpoints
- optional: permissioned spaces and group-controlled communities

mostly tested on cloudflare workers with d1 but should run in any node env too (+ has adapters for node:sqlite and postgres for the db).

## Install

```bash
pnpm add @atmo-dev/contrail
```

## Minimal example

a complete cloudflare worker that indexes public calendar events from the atproto network and serves them over a typed XRPC endpoint. two files + config. a runnable version lives in [`apps/cloudflare-workers`](./apps/cloudflare-workers) — clone, deploy, `pnpm contrail backfill --remote`, done.

**`src/contrail.config.ts`** — picked up automatically by the `contrail` CLI:

```ts
import type { ContrailConfig } from "@atmo-dev/contrail";

export const config: ContrailConfig = {
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event", // NSID to index
      queryable: { startsAt: { type: "range" } },     // ?startsAtMin=...
      searchable: ["name", "description"],            // ?search=...
    },
  },
};
```

**`src/worker.ts`** — serves XRPC requests, pulls new records every minute:

```ts
import { Contrail } from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import { config } from "./contrail.config";

const contrail = new Contrail(config);
const handle = createHandler(contrail);
let ready = false;

export default {
  async fetch(req: Request, env: { DB: D1Database }) {
    if (!ready) { await contrail.init(env.DB); ready = true; } // create tables once
    return handle(req, env.DB);                                // xrpc routes
  },
  async scheduled(_ev: ScheduledEvent, env: { DB: D1Database }, ctx: ExecutionContext) {
    ctx.waitUntil(contrail.ingest({}, env.DB));                // pull new records
  },
};
```

and a d1 binding + cron in `wrangler.jsonc`:

```jsonc
{
  "main": "src/worker.ts",
  "d1_databases": [{ "binding": "DB", "database_name": "contrail", "database_id": "..." }],
  "triggers": { "crons": ["*/1 * * * *"] }
}
```

then:

```bash
npx wrangler d1 create contrail   # copy the id into wrangler.jsonc
pnpm wrangler deploy              # deploy the worker
pnpm contrail backfill --remote   # one-shot historical backfill
```

the worker keeps itself fresh from now on via the cron. hit:

```
GET https://<your-worker>.workers.dev/xrpc/com.example.event.listRecords?startsAtMin=2026-01-01&limit=10
```

returns every `community.lexicon.calendar.event` record published anywhere on atproto that matches, as JSON. that's it — no PDS setup, no lexicon publishing, no relay configuration. everything scales from there: add filters, add full-text search, add more collections, turn on [spaces](./docs/04-spaces.md) for private records, mount the handler in sveltekit instead, swap the adapter for postgres.

**not using workers?** same library, different `db`. see [adapters](./docs/01-indexing.md#adapters) for node:sqlite and postgres.

## Docs

- [Indexing](./docs/01-indexing.md) — the core: collections, ingestion, adapters
- [Querying](./docs/02-querying.md) — filters, sorts, hydration, search, pagination
- [Lexicons](./docs/03-lexicons.md) — `contrail-lex` CLI, codegen, publishing
- [Spaces](./docs/04-spaces.md) — permissioned records stored by the appview
- [Communities](./docs/05-communities.md) — group-controlled atproto DIDs
- [Sync](./docs/06-sync.md) — reactive client-side store over `watchRecords`
- [Examples](./docs/07-examples.md) — reference deployments in the repo
- Frameworks: [SvelteKit + Cloudflare](./docs/frameworks/sveltekit-cloudflare.md)

## Packages

| Package | |
|---|---|
| `@atmo-dev/contrail` | Core library — indexing, XRPC server, spaces, communities, realtime |
| `@atmo-dev/contrail-sync` | Client-side reactive watch-store with optional IndexedDB cache |
| `@atmo-dev/contrail-lexicons` | Codegen + `contrail-lex` CLI |

Working in this repo? See [development.md](https://github.com/flo-bit/contrail/blob/main/development.md) for the monorepo layout and commands.
