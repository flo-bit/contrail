# sveltekit + contrail + atproto OAuth

A sveltekit example app on cloudflare workers with self-hosted atproto record indexing via [contrail](https://github.com/flo-bit/contrail), fully typed queries, and OAuth authentication.

## Setup

```sh
pnpm install
pnpm dev
```

Dev mode uses a loopback OAuth client — no keys or Cloudflare setup needed.

## Config

Define which AT Protocol collections to index in `src/lib/contrail/config.ts`:

```ts
import type { ContrailConfig } from '@atmo-dev/contrail';

export const config: ContrailConfig = {
  namespace: 'statusphere.app',
  collections: {
    status: {                                  // short name → URL path segment
      collection: 'xyz.statusphere.status',    // full NSID of the record type
      queryable: {
        status: {},                    // equality filter (?status=...)
        createdAt: { type: 'range' }   // range filter (?createdAtMin=...&createdAtMax=...)
      }
    }
  }
};
```

After changing the config, run `pnpm generate:pull` to regenerate lexicons and types.

Run `pnpm sync` to backfill existing records from the network.

Wrangler bindings (`wrangler.jsonc`):

- **D1** (`DB`) — contrail's database
- **KV** (`OAUTH_SESSIONS`, `OAUTH_STATES`) — OAuth session storage
- **Vars** — `CRON_SECRET`, `OAUTH_PUBLIC_URL`, `CLIENT_ASSERTION_KEY`, `COOKIE_SECRET`

## Deploy

```sh
npx wrangler d1 create statusphere
# Add database_id to wrangler.jsonc

pnpm build
npx wrangler deploy
```

## How it works

**Contrail** indexes AT Protocol records into D1 via Jetstream (cron, every minute). When a user posts, `contrail.notify()` indexes it immediately.

**Typed queries** use `@atcute/client` with an in-process handler — full type safety, zero HTTP overhead:

```ts
const client = getClient(platform!.env.DB);
const res = await client.get('statusphere.app.status.listRecords', {
  params: { limit: 50, profiles: true }  // typed params
});
res.data.records  // typed response
```

Types are generated from contrail's config via `pnpm generate:pull`, which produces lexicon JSON and TypeScript types that register with `@atcute/client`.

**Scheduled ingestion** works around SvelteKit's lack of `scheduled` export support ([sveltejs/kit#4841](https://github.com/sveltejs/kit/issues/4841)) by appending a handler post-build that self-calls `/api/cron`.

**OAuth** uses `@atcute/oauth-node-client` with KV-backed sessions and HMAC-signed cookies.

## License

MIT
