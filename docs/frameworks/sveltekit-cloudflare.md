# SvelteKit + Cloudflare Workers

How to add contrail to an existing SvelteKit project deployed on Cloudflare Workers (via `@sveltejs/adapter-cloudflare`). Gives you XRPC endpoints alongside your pages, Jetstream ingestion on cron, and a typed in-process client for server loaders.

Assumes you already have a SvelteKit app with `@sveltejs/adapter-cloudflare` and a D1 binding. If you don't, [`apps/sveltekit-cloudflare-workers`](https://github.com/flo-bit/contrail/tree/main/apps/sveltekit-cloudflare-workers) is a complete starting point.

## Install

```bash
pnpm add @atmo-dev/contrail
pnpm add -D @atmo-dev/contrail-lexicons @atcute/lex-cli
```

## Project layout

```
src/
  lib/
    contrail.config.ts       # your config — auto-detected by the CLI
    contrail/
      index.ts               # Contrail instance + ensureInit + server client
  routes/
    xrpc/[...path]/+server.ts   # mounts all contrail XRPC endpoints
    api/cron/+server.ts         # hit by the cron trigger (see below)
wrangler.jsonc
scripts/
  append-scheduled.ts        # workaround — see "Cron" below
```

## 1. Declare the config

```ts
// src/lib/contrail.config.ts
import type { ContrailConfig } from "@atmo-dev/contrail";

export const config: ContrailConfig = {
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { startsAt: { type: "range" } },
      searchable: ["name", "description"],
    },
  },
};
```

## 2. The Contrail instance

```ts
// src/lib/contrail/index.ts
import { Contrail } from "@atmo-dev/contrail";
import { createHandler, createServerClient } from "@atmo-dev/contrail/server";
import type { Client } from "@atcute/client";
import { config } from "../contrail.config";

export const contrail = new Contrail(config);

let initialized = false;
export async function ensureInit(db: D1Database) {
  if (!initialized) { await contrail.init(db); initialized = true; }
}

const handle = createHandler(contrail);

/** Typed in-process XRPC client for loaders / actions. Pass `did` to act as
 *  that user (no JWT / PDS roundtrip); omit for anonymous public reads. */
export function getServerClient(db: D1Database, did?: string): Client {
  return createServerClient(async (req) => {
    await ensureInit(db);
    return handle(req, db) as Promise<Response>;
  }, did);
}
```

Why the lazy `ensureInit`: Workers cold-start many times; doing schema init on the first request keeps the boot path fast and means `contrail.init()` doesn't need top-level `await` (which the adapter doesn't love).

## 3. Mount the XRPC routes

One catch-all that forwards to contrail's handler:

```ts
// src/routes/xrpc/[...path]/+server.ts
import type { RequestHandler } from "./$types";
import { createHandler } from "@atmo-dev/contrail/server";
import { contrail, ensureInit } from "$lib/contrail";

const handle = createHandler(contrail);

async function h(req: Request, platform: App.Platform | undefined) {
  const db = platform!.env.DB;
  await ensureInit(db);
  return handle(req, db) as Promise<Response>;
}

export const GET: RequestHandler  = ({ request, platform }) => h(request, platform);
export const POST: RequestHandler = ({ request, platform }) => h(request, platform);
```

Now every `com.example.*.listRecords` / `com.example.*.getRecord` / `com.example.notifyOfUpdate` / etc. is served under `/xrpc/...`.

## 4. Using the typed client in loaders

```ts
// src/routes/+page.server.ts
import { getServerClient } from "$lib/contrail";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ platform, locals }) => {
  const rpc = getServerClient(platform!.env.DB, locals.did ?? undefined);
  const res = await rpc.get("com.example.event.listRecords", {
    params: { startsAtMin: "2026-01-01", limit: 20 },
  });
  return { events: res.ok ? res.data.records : [] };
};
```

`createServerClient` bypasses fetch — the loader runs contrail's XRPC handler in-process, no extra network hop. `did` sets the caller identity without requiring a signed JWT (it's a server-to-server trust boundary; anything crossing an untrusted boundary still needs real service-auth).

## 5. Cron ingest — the workaround

SvelteKit's `@sveltejs/adapter-cloudflare` doesn't expose a `scheduled()` export on the generated worker ([issue #4841](https://github.com/sveltejs/kit/issues/4841)). The easiest fix: an HTTP endpoint that does the ingest, plus a post-build script that appends a `scheduled` handler calling that endpoint.

**Endpoint:**

```ts
// src/routes/api/cron/+server.ts
import type { RequestHandler } from "./$types";
import { contrail, ensureInit } from "$lib/contrail";

export const POST: RequestHandler = async ({ request, platform }) => {
  if (request.headers.get("X-Cron-Secret") !== platform!.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  const db = platform!.env.DB;
  await ensureInit(db);
  await contrail.ingest({}, db);
  return new Response("OK");
};
```

**Post-build patch:**

```ts
// scripts/append-scheduled.ts
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = join(root, ".svelte-kit", "cloudflare", "_worker.js");

writeFileSync(
  workerPath,
  readFileSync(workerPath, "utf-8") +
    `
worker_default.scheduled = async function (event, env, ctx) {
  const req = new Request("http://localhost/api/cron", {
    method: "POST",
    headers: { "X-Cron-Secret": env.CRON_SECRET ?? "" },
  });
  ctx.waitUntil(this.fetch(req, env, ctx));
};
`
);
```

**Wire it into `build`:**

```jsonc
// package.json
"scripts": {
  "build": "vite build && tsx scripts/append-scheduled.ts"
}
```

`CRON_SECRET` is any random string — generate one, set it as a secret with `wrangler secret put CRON_SECRET`. The cron handler self-auths with it so nobody external can trigger your ingest.

## 6. Wrangler config

```jsonc
// wrangler.jsonc
{
  "main": ".svelte-kit/cloudflare/_worker.js",
  "compatibility_date": "2025-12-25",
  "compatibility_flags": ["nodejs_compat_v2"],
  "assets": { "binding": "ASSETS", "directory": ".svelte-kit/cloudflare" },
  "d1_databases": [
    { "binding": "DB", "database_name": "yourapp", "database_id": "..." }
  ],
  "triggers": { "crons": ["*/1 * * * *"] }
}
```

Type the D1 binding in `src/app.d.ts`:

```ts
declare global {
  namespace App {
    interface Platform {
      env: {
        DB: D1Database;
        CRON_SECRET: string;
        // ...other bindings
      };
    }
  }
}
```

## 7. Deploy + backfill

```bash
npx wrangler d1 create yourapp       # copy the id into wrangler.jsonc
pnpm build && pnpm wrangler deploy
npx wrangler secret put CRON_SECRET  # paste any random string
pnpm contrail backfill --remote      # one-time historical backfill
```

From now on:

- Pages and XRPC endpoints are served under your domain.
- The cron fires every minute, hitting `/api/cron`, which runs `contrail.ingest()`.
- Loaders that need live data use `getServerClient()` for zero-overhead typed calls.
- Need to reconcile after an outage? `pnpm contrail refresh --remote`.

## Where to go next

- [Indexing](../01-indexing.md) — config options, adapter choices
- [Querying](../02-querying.md) — filters, sorts, hydration, search
- [Lexicons](../03-lexicons.md) — generate TS types for your XRPC surface
- [Spaces](../04-spaces.md) / [Communities](../05-communities.md) — private records + group-controlled DIDs, which both slot into the same handler you just mounted
- [Sync](../06-sync.md) — reactive client-side subscriptions (`createWatchStore`) wrapped in Svelte `$state`

## Common gotchas

- **Top-level await in `$lib/contrail/index.ts`** will fail to bundle — use the lazy `ensureInit` pattern above.
- **`ensureInit` is per-isolate, not global.** Cloudflare cold-starts spin new isolates; each one pays one init call on its first request. `contrail.init()` is idempotent so this is safe, just not instant.
- **SvelteKit's `adapter-cloudflare` regenerates `_worker.js` on every build**, so the `append-scheduled.ts` patch has to run *after* `vite build`. Don't try to put it in `prebuild`.
- **`D1Database` type in platform env** needs `@cloudflare/workers-types` in `devDependencies` and `types` in your tsconfig.
