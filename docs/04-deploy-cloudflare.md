# Deploy to Cloudflare Workers & Node

## Standalone Cloudflare Worker + D1

From the directory containing `contrail.config.ts` (run `pnpm init` first if there is no `package.json` yet):

```bash
pnpm init
pnpm add @atmo-dev/contrail
pnpm add -D @atcute/lex-cli wrangler typescript
```

Set a stable `orderedSource` in `contrail.config.ts` (keep `epoch` unchanged for the lifetime of the database):

```ts
import type { ContrailConfig } from "@atmo-dev/contrail";

export default {
  namespace: "com.example",
  orderedSource: { source: "jetstream", epoch: "my-appview-v1" },
  collections: {
    // ...
  },
} satisfies ContrailConfig;
```

Generate the Lexicons:

```bash
pnpm contrail lexicons all --public
```

Create `worker.ts`:

```ts
import { createWorker } from "@atmo-dev/contrail/worker";
import config from "./contrail.config";
import { lexicons } from "./lexicons/generated";

export default createWorker(config, {
  lexicons,
  publicService: { endpoint: "https://my-appview.example.com" },
});
```

Create `wrangler.jsonc`:

```jsonc
{
  "name": "my-appview",
  "main": "worker.ts",
  "compatibility_date": "2026-01-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-appview",
      "database_id": "PASTE_DATABASE_ID_HERE"
    }
  ],
  "triggers": { "crons": ["*/1 * * * *"] }
}
```

Provision D1, deploy, and backfill:

```bash
pnpm wrangler d1 create my-appview   # paste database_id into wrangler.jsonc
pnpm wrangler deploy
pnpm contrail backfill --remote      # or add --alluvium on an empty D1 database
```

Verify and connect your consumer app:

```bash
curl https://my-appview.example.com/status
pnpx @atmo-dev/contrail connect https://my-appview.example.com
```

When changing config later: regenerate Lexicons, redeploy, run `contrail backfill --remote` for new collections, and reconnect clients with `--update`.

## Embedding in SvelteKit (Cloudflare Workers)

Skip a separate Worker when your SvelteKit app already runs on Cloudflare Workers:

```ts
// src/lib/server/contrail.ts
import { Contrail } from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import config from "./contrail.config";

export const contrail = new Contrail(config);
export const handleContrail = createHandler(contrail);
```

- Forward `/xrpc/[...path]` to `handleContrail(request, platform.env.DB)` after `await contrail.init(platform.env.DB, { deferModerationPolicyJob: true })`.
- Run `await contrail.ingest({}, platform.env.DB)` from a protected cron endpoint, or use `contrail append-scheduled` on the built Worker bundle so Cloudflare's `scheduled` trigger calls it.

## Node.js (SQLite, PostgreSQL, PGlite)

For long-lived Node servers, use `createHandler(contrail)` with `contrail.runPersistent({ signal })` instead of cron:

- **SQLite (`@atmo-dev/contrail/sqlite`):** `createSqliteDatabase("./data/contrail.sqlite")` — see [apps/sqlite](../apps/sqlite/README.md).
- **PostgreSQL (`@atmo-dev/contrail/postgres`):** `createPostgresDatabase(new pg.Pool({ connectionString }))` — see [apps/postgres](../apps/postgres/README.md).
- **PGlite (`@atmo-dev/contrail/pglite`):** `createPgliteDatabase(new PGlite("./data/pg"))` for embedded Postgres with no server.

## Next steps

- [Feeds](./advanced/feeds.md) — per-actor following timelines
- [Labels](./advanced/labels.md) — labeler subscriptions and author self-labels
- [Moderation](./advanced/moderation.md) — hides, takedowns, account lifecycle, and private reports
- [Outbox](./advanced/outbox.md) — transactional change delivery to search/webhooks
- [Remote D1](./advanced/remote-d1.md) — remote D1 backfill, Alluvium cutover, and safe config upgrades
