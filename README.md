# Contrail

> **Pre-alpha.** Expect breaking changes.

A library for building AT Protocol appviews. Declare your collections, get automatic Jetstream ingestion, typed XRPC endpoints, optional permissioned spaces for private records, group-controlled communities, and a client-side reactive sync layer. Runs on Cloudflare Workers + D1, Node.js + PostgreSQL, or SvelteKit.

## Install

```bash
pnpm add @atmo-dev/contrail
```

## Minimal example

```ts
import { Contrail } from "@atmo-dev/contrail";

const contrail = new Contrail({
  namespace: "com.example",
  db, // D1, node:sqlite, or @atmo-dev/contrail/postgres
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { startsAt: { type: "range" } },
      searchable: ["name", "description"],
    },
  },
});

await contrail.init();
await contrail.ingest(); // pulls from Jetstream
```

Mount the XRPC handler in any fetch-style framework:

```ts
import { createHandler } from "@atmo-dev/contrail/server";
export default { fetch: createHandler(contrail) };
```

## Docs

- [Indexing](./docs/indexing.md) — the core: collections, queries, ingestion, adapters
- [Spaces](./docs/spaces.md) — permissioned records stored by the appview
- [Communities](./docs/communities.md) — group-controlled atproto DIDs
- [Sync](./docs/sync.md) — reactive client-side store over `watchRecords`
- [Lexicons](./docs/lexicons.md) — `contrail-lex` CLI and codegen

## Packages

| Package | |
|---|---|
| `@atmo-dev/contrail` | Core library — indexing, XRPC server, spaces, communities, realtime |
| `@atmo-dev/contrail-sync` | Client-side reactive watch-store with optional IndexedDB cache |
| `@atmo-dev/contrail-lexicons` | Codegen + `contrail-lex` CLI |

Working in this repo? See [development.md](https://github.com/flo-bit/contrail/blob/main/development.md) for the monorepo layout and commands.
