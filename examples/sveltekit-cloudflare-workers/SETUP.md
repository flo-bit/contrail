# Adding AT Protocol OAuth to your SvelteKit + Cloudflare Workers project

## 1. Install dependencies

```sh
pnpm add valibot
pnpm add -D @atcute/oauth-node-client @atcute/identity-resolver @atcute/lexicons @atcute/client @atcute/tid @cloudflare/workers-types tsx
```

Add any lexicon types you need (e.g. `@atcute/atproto`, `@atcute/bluesky`).

## 2. Copy files

Copy these into your project:

- `src/lib/atproto/` — auth state, methods, server logic, scripts
- `src/routes/(oauth)/` — OAuth callback, JWKS, and client metadata endpoints

## 3. Configure

**`src/lib/atproto/settings.ts`** — set your app's permissions:

```ts
export const permissions = {
  collections: ['your.collection.name'],
  rpc: {},
  blobs: []
} as const;
```

The OAuth scope is auto-generated from this config.

**`src/app.d.ts`** — add session types:

```ts
import type { OAuthSession } from '@atcute/oauth-node-client';
import type { Client } from '@atcute/client';
import type { Did } from '@atcute/lexicons';

declare global {
  namespace App {
    interface Locals {
      session: OAuthSession | null;
      client: Client | null;
      did: Did | null;
    }
    interface Platform {
      env: {
        OAUTH_SESSIONS: KVNamespace;
        OAUTH_STATES: KVNamespace;
        CLIENT_ASSERTION_KEY: string;
        COOKIE_SECRET: string;
        OAUTH_PUBLIC_URL: string;
        PROFILE_CACHE?: KVNamespace; // optional
      };
    }
  }
}

import type {} from '@atcute/atproto';
import type {} from '@atcute/bluesky';
export {};
```

**`src/hooks.server.ts`** — restore session on every request:

```ts
import type { Handle } from '@sveltejs/kit';
import { restoreSession } from '$lib/atproto/server/session';

export const handle: Handle = async ({ event, resolve }) => {
  const { session, client, did } = await restoreSession(
    event.cookies, event.platform?.env
  );
  event.locals.session = session;
  event.locals.client = client;
  event.locals.did = did;
  return resolve(event);
};
```

**`wrangler.jsonc`** — add KV namespaces and public URL:

```sh
npx wrangler kv namespace create OAUTH_SESSIONS
npx wrangler kv namespace create OAUTH_STATES
```

add to `wrangler.jsonc` (change the name, url and ids):
```jsonc
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "{your-worker-name}",
	"main": ".svelte-kit/cloudflare/_worker.js",
	"compatibility_date": "2025-12-25",
  "compatibility_flags": ["nodejs_compat_v2"],
  "vars": {
    //for production: "OAUTH_PUBLIC_URL": "https://your-domain.com"
  },
  "kv_namespaces": [
    { "binding": "OAUTH_SESSIONS", "id": "<your-id>" },
    { "binding": "OAUTH_STATES", "id": "<your-id>" }
  ]
}
```

**`package.json`** — add helper scripts:

```json
{
  "env:generate-key": "npx tsx src/lib/atproto/scripts/generate-key.ts",
  "env:generate-secret": "npx tsx src/lib/atproto/scripts/generate-secret.ts",
  "env:setup-dev": "npx tsx src/lib/atproto/scripts/setup-dev.ts"
}
```

**`.env.example`**:

```
CLIENT_ASSERTION_KEY=
COOKIE_SECRET=
# Set to your tunnel URL to use a confidential client in dev
OAUTH_PUBLIC_URL=
```

## 4. Load profile (optional)

Add a `src/routes/+layout.server.ts` to load the user's Bluesky profile on every page:

```ts
import type { LayoutServerLoad } from './$types';
import { loadProfile } from '$lib/atproto/server/profile';

export const load: LayoutServerLoad = async ({ locals, platform }) => {
  if (!locals.did) return { did: null, profile: null };
  const profile = await loadProfile(locals.did, platform?.env?.PROFILE_CACHE);
  return { did: locals.did, profile };
};
```

For optional profile caching, create a KV namespace and add it to `wrangler.jsonc`:

```sh
npx wrangler kv namespace create PROFILE_CACHE
```

## 5. Generate secrets

For local dev:

```sh
pnpm env:setup-dev
```

For production:

```sh
pnpm env:generate-key
npx wrangler secret put CLIENT_ASSERTION_KEY  # paste the generated key

pnpm env:generate-secret
npx wrangler secret put COOKIE_SECRET  # paste the generated secret
```

## 6. Add login UI

### Option A: `@foxui/social` login modal

Install the UI packages:

```sh
pnpm add @foxui/social @foxui/core
```

Add the login modal to your root layout (`src/routes/+layout.svelte`):

```svelte
<script lang="ts">
  import { AtprotoLoginModal } from '@foxui/social';
  import { login, signup } from '$lib/atproto';

  let { children } = $props();
</script>

{@render children()}

<AtprotoLoginModal
  login={async (handle) => {
    await login(handle);
    return true;
  }}
  signup={async () => {
    signup();
    return true;
  }}
/>
```

Then open the modal from anywhere:

```svelte
<script lang="ts">
  import { Button } from '@foxui/core';
  import { atProtoLoginModalState } from '@foxui/social';
  import { user, logout } from '$lib/atproto';
</script>

{#if user.isLoggedIn}
  <p>Signed in as {user.profile?.handle ?? user.did}</p>
  <Button onclick={() => logout()}>Sign Out</Button>
{:else}
  <Button onclick={() => atProtoLoginModalState.show()}>Sign In</Button>
{/if}
```

### Option B: Simple inline login

```svelte
<script lang="ts">
  import { user, login, logout } from '$lib/atproto';
</script>

{#if user.isLoggedIn}
  <p>Signed in as {user.did}</p>
  <button onclick={() => logout()}>Sign Out</button>
{:else}
  <button onclick={() => login('user.bsky.social')}>Sign In</button>
{/if}
```

### Write operations

```ts
import { putRecord, deleteRecord, uploadBlob } from '$lib/atproto';

await putRecord({
  collection: 'your.collection.name',
  rkey: 'some-key',
  record: { text: 'hello', createdAt: new Date().toISOString() }
});

await deleteRecord({ collection: 'your.collection.name', rkey: 'some-key' });

const blob = await uploadBlob({ blob: file });
```

### Read operations (no auth needed)

```ts
import { listRecords, getRecord, getDetailedProfile } from '$lib/atproto';

const records = await listRecords({ did: 'did:plc:...', collection: 'your.collection.name' });
const profile = await getDetailedProfile({ did: 'did:plc:...' });
```

### Server load functions

```ts
export const load = async ({ locals }) => {
  if (!locals.client || !locals.did) return { data: null };

  const response = await locals.client.get('com.atproto.repo.listRecords', {
    params: { repo: locals.did, collection: 'your.collection.name' }
  });

  return { data: response.data };
};
```

## Dev with tunnel (optional)

To test the confidential client flow locally:

1. `pnpm env:setup-dev`
2. Add tunnel URL to `.env`: `OAUTH_PUBLIC_URL=https://your-tunnel.trycloudflare.com`
3. `pnpm tunnel`
4. `pnpm dev`

Without `OAUTH_PUBLIC_URL`, dev mode uses a loopback public client (no keys needed).
