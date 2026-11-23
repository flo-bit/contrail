# @atmo-dev/contrail

> Pre-alpha. Expect breaking changes.

Turn public AT Protocol records into a queryable AppView on Cloudflare Workers + D1, or Node.js with SQLite, PostgreSQL, or PGlite.

## Quick start

```bash
pnpx @atmo-dev/contrail init my-appview \
  --prefix community.lexicon.calendar. \
  --namespace com.example.calendar
cd my-appview
pnpx @atmo-dev/contrail dev
```

Or install into an existing project:

```bash
pnpm add @atmo-dev/contrail
```

```ts
// contrail.config.ts
import type { ContrailConfig } from "@atmo-dev/contrail";

export default {
  namespace: "com.example",
  orderedSource: { source: "jetstream", epoch: "my-app-v1" },
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { mode: {}, startsAt: { type: "range" } },
      searchable: ["name", "description"],
    },
  },
} satisfies ContrailConfig;
```

```ts
// worker.ts
import { createWorker } from "@atmo-dev/contrail/worker";
import config from "./contrail.config";
import { lexicons } from "./lexicons/generated";

export default createWorker(config, {
  lexicons,
  publicService: { endpoint: "https://my-appview.example.com" },
});
```

## CLI

```bash
contrail init [dir] [--prefix <nsid.>] [--namespace <nsid>]
contrail dev [--alluvium] [--wrangler] [--port 8787]
contrail backfill [--remote] [--alluvium] [--env <name>] [--sqlite <path>]
contrail connect <config-dir-or-url> [--update]
contrail lexicons all [--public]
contrail lexicons check
```

## Entrypoints

| Import | Purpose |
| --- | --- |
| `@atmo-dev/contrail` | Core `Contrail` class, config types, queries, ingestion, moderation |
| `@atmo-dev/contrail/worker` | `createWorker()` for Cloudflare Workers + D1 |
| `@atmo-dev/contrail/server` | `createHandler()` and `createServerClient()` for custom servers / SvelteKit |
| `@atmo-dev/contrail/client` | Public XRPC client helpers |
| `@atmo-dev/contrail/moderation` | Client helpers for reports, actions, and moderation OAuth scopes |
| `@atmo-dev/contrail/sqlite` | Node.js `node:sqlite` adapter |
| `@atmo-dev/contrail/postgres` | `pg` Pool adapter |
| `@atmo-dev/contrail/pglite` | Embedded PGlite adapter |
| `@atmo-dev/contrail/alluvium` | Resumable Alluvium export bootstrap |
| `@atmo-dev/contrail/workers` | Wrangler-backed `backfillAll`, `bootstrapAlluvium`, `labelsBackfillAll` |
| `@atmo-dev/contrail/lexicons` | Programmatic Lexicon generator |

## Docs

Full guides live in the [repository](https://github.com/flo-bit/contrail):

- [Get started locally](https://github.com/flo-bit/contrail/blob/main/docs/01-getting-started.md)
- [Add the typed client](https://github.com/flo-bit/contrail/blob/main/docs/02-client.md)
- [Configure and query](https://github.com/flo-bit/contrail/blob/main/docs/03-configure-and-query.md)
- [Deploy to Cloudflare Workers & Node](https://github.com/flo-bit/contrail/blob/main/docs/04-deploy-cloudflare.md)
- Advanced: [Feeds](https://github.com/flo-bit/contrail/blob/main/docs/advanced/feeds.md) · [Labels](https://github.com/flo-bit/contrail/blob/main/docs/advanced/labels.md) · [Moderation](https://github.com/flo-bit/contrail/blob/main/docs/advanced/moderation.md) · [Remote D1](https://github.com/flo-bit/contrail/blob/main/docs/advanced/remote-d1.md)
