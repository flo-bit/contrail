# Contrail

> **Pre-alpha.** Expect breaking changes.

Contrail turns public AT Protocol records into a queryable AppView.

It provides:

- historical backfill from relays and PDSes;
- current updates from Jetstream;
- D1, SQLite, and PostgreSQL storage;
- `getRecord` and `listRecords` HTTP endpoints;
- filters, sorting, search, and pagination;
- custom queries;
- relationship counts and hydration; and
- profile and label hydration.

Cloudflare Workers with D1 is the primary deployment target. Node.js with SQLite or PostgreSQL is also supported.

## Install

```bash
pnpm add @atmo-dev/contrail
```

## Minimal Worker

```ts
// src/contrail.config.ts
import type { ContrailConfig } from "@atmo-dev/contrail";

export const config: ContrailConfig = {
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: {
        mode: {},
        startsAt: { type: "range" },
      },
      searchable: ["name", "description"],
    },
  },
};
```

```ts
// src/worker.ts
import { createWorker } from "@atmo-dev/contrail/worker";
import { config } from "./contrail.config";

export default createWorker(config);
```

Add a D1 binding and one-minute cron to `wrangler.jsonc`:

```jsonc
{
  "main": "src/worker.ts",
  "d1_databases": [
    { "binding": "DB", "database_name": "contrail", "database_id": "..." }
  ],
  "triggers": { "crons": ["*/1 * * * *"] }
}
```

Then deploy and backfill:

```bash
npx wrangler d1 create contrail
pnpm wrangler deploy
pnpm contrail backfill --remote
```

Query the resulting AppView:

```text
GET /xrpc/com.example.event.listRecords?startsAtMin=2026-01-01&limit=10
GET /status
```

The JSON status response reports live cursor lag, indexed records, known backfill progress, and currently unreachable accounts. Failed PDS work remains pending and is retried automatically in small, backed-off slices after scheduled live ingestion.

For ordinary Lexicon parsing, validation, pulling, and TypeScript generation, use [Atcute](https://github.com/mary-ext/atcute) directly. Contrail no longer ships a separate Lexicon toolchain.

## Other databases

```ts
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
```

See [Indexing](docs/01-indexing.md) for adapter setup and [Querying](docs/02-querying.md) for the query and hydration model.

## Documentation

- [Indexing](docs/01-indexing.md)
- [Querying](docs/02-querying.md)
- [Feeds](docs/04-feeds.md)
- [Labels](docs/09-labels.md)
- [SvelteKit + Cloudflare](docs/frameworks/sveltekit-cloudflare.md)

## Repository layout

There is one published package and one implementation:

```text
packages/contrail/   @atmo-dev/contrail
```

The previous AppView, base, community, authority, record-host, sync, and Lexicon packages have been removed.

See [development.md](development.md) for repository commands.
