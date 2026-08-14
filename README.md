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

For local development, a directory containing only `contrail.config.ts` can run `contrail dev`. It resolves source Lexicons, creates a resumable SQLite database, backfills it, follows Jetstream in bounded cycles, exposes the public XRPC service on `http://127.0.0.1:8787`, and generates the local consumer types/client automatically. Wrangler projects continue to use their local D1 automatically.

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
pnpm wrangler d1 create contrail
pnpm wrangler deploy
pnpm contrail backfill --remote
```

Query the resulting AppView:

```text
GET /xrpc/com.example.event.listRecords?startsAtMin=2026-01-01&limit=10
GET /status
```

The JSON status response reports live cursor lag, indexed records, known backfill progress, and mutually exclusive pending/retrying/failed account counts. Failed PDS work is retried automatically in small scheduled slices with backoff up to 48 hours.

## Lexicons

Generate query Lexicons from the Contrail config and detect checked-in drift:

```bash
pnpm contrail lexicons generate
pnpm contrail lexicons check
```

Use `contrail lexicons all` to generate Contrail methods, pull referenced source Lexicons, and generate TypeScript types in one pass. The `pull` and `types` actions are also available separately. Contrail updates `lex.config.js` only when the file carries its generated marker; user-owned Atcute configuration is preserved. Pass `--no-atcute-config` to skip creating or checking that generated file. Contrail owns its config-specific query generation while delegating generic pulling and TypeScript generation to [Atcute](https://github.com/mary-ext/atcute).

## Public read-through services

A deployment can publish a verified contract and Lexicon bundle for independent typed clients:

```ts
export default createWorker(config, {
  lexicons,
  publicService: { endpoint: "https://api.example.com" },
});
```

Contrail remains a read-through cache over public AT Protocol data: anonymous reads may resolve identities, fetch missing public records, and improve profile or feed projections. Custom query handlers are public when they have matching authored query Lexicons. Anonymous discovery uses the HTTPS origin directly and does not require a service DID. The optional `notifyOfUpdate` procedure is not advertised in the anonymous read contract.

Consumers connect and generate Atcute types with one command:

```bash
pnpx @atmo-dev/contrail connect https://api.example.com
```

The generated client pins and verifies the discovered contract digest before its first provider request; transient discovery failures can retry, while endpoint, service-DID, and contract mismatches fail closed.

Public-service mode requires `orderedSource`; `getCursor` then returns the committed opaque `{ source, epoch, cursor }` position of that primary source. Compare complete positions for equality only; a source or epoch change requires a full client refetch. To avoid racing ingestion, read a position before and after a query and accept the query snapshot only when both positions match. Existing non-public deployments without `orderedSource` retain the legacy `time_us`, `date`, and `seconds_ago` response.

## Other databases

```ts
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
```

The runnable [`apps/sqlite`](apps/sqlite) example wires the standard backfill CLI to a local SQLite file, including the optional Alluvium base/archive path. See [Indexing](docs/01-indexing.md) for adapter setup and [Querying](docs/02-querying.md) for the query and hydration model.

## Documentation

- [Indexing](docs/01-indexing.md)
- [Querying](docs/02-querying.md)
- [Feeds](docs/04-feeds.md)
- [Labels](docs/09-labels.md)
- Public Contrail services:
  - [Creating a service](docs/public-services/creating.md)
  - [Using a service](docs/public-services/using.md)
  - [Example: api.atmo.rsvp](docs/public-services/api-atmo-rsvp.md)
- [SvelteKit + Cloudflare](docs/frameworks/sveltekit-cloudflare.md)

## Repository layout

There is one published package and one implementation:

```text
packages/contrail/   @atmo-dev/contrail
```

The previous AppView, base, community, authority, record-host, sync, and Lexicon packages have been removed.

See [development.md](development.md) for repository commands.
