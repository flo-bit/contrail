# Deploy to Cloudflare Workers

Turn the same local AppView into a public Worker backed by D1.

## Install

From the directory containing `contrail.config.ts`:

```bash
pnpm init
pnpm add @atmo-dev/contrail
pnpm add -D @atcute/lex-cli wrangler typescript
```

Add an ordered source to the config. Keep its epoch stable for the lifetime of this database:

```ts
// contrail.config.ts
import type { ContrailConfig } from "@atmo-dev/contrail";

const config: ContrailConfig = {
  namespace: "com.example",
  orderedSource: {
    source: "jetstream",
    epoch: "my-appview-v1",
  },
  collections: {
    // ...your existing collections
  },
};

export default config;
```

Generate the public query Lexicons and their referenced record Lexicons:

```bash
pnpm contrail lexicons all --public
```

## Create the Worker

```ts
// worker.ts
import { createWorker } from "@atmo-dev/contrail/worker";
import config from "./contrail.config";
import { lexicons } from "./lexicons/generated";

export default createWorker(config, {
  lexicons,
  publicService: {
    endpoint: "https://my-appview.example.com",
  },
});
```

Use the Worker's actual `workers.dev` or custom-domain URL as `endpoint`.

Create `wrangler.jsonc`:

```jsonc
{
  "name": "my-appview",
  "main": "worker.ts",
  "compatibility_date": "2025-12-25",
  "observability": { "enabled": true },
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

## Deploy and backfill

```bash
pnpm wrangler d1 create my-appview  # copy its ID into wrangler.jsonc
pnpm wrangler deploy
pnpm contrail backfill --remote
```

The one-minute cron keeps the AppView current. Check it with:

```bash
curl https://my-appview.example.com/status
curl 'https://my-appview.example.com/xrpc/com.example.event.listRecords?limit=10'
```

Finally, point the application from the previous guide at the deployment:

```bash
pnpx @atmo-dev/contrail connect https://my-appview.example.com
```

When the config changes, regenerate the Lexicons, deploy, backfill any new collections, and reconnect the client with `--update`.

For optional outbox deliveries, feeds, and labels, see [advanced topics](./advanced/README.md).
