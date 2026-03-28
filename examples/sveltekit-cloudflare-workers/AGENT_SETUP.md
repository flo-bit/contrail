# Add AT Protocol OAuth to SvelteKit + Cloudflare Workers

You are adding AT Protocol OAuth authentication to an existing SvelteKit project deployed on Cloudflare Workers. This uses server-side OAuth with `@atcute/oauth-node-client`, Cloudflare KV for session storage, and SvelteKit remote functions.

## Prerequisites

The project must already use:
- SvelteKit with `@sveltejs/adapter-cloudflare`
- A `wrangler.jsonc` (or `wrangler.toml`) config

## Step 0: Understand the project and propose an integration approach

Before asking configuration questions, **explore the existing codebase** to understand what the app does. Read the main pages, components, state management, and data flow. Then propose to the user *how* AT Protocol should integrate with their app.

### What to look for

- **User data**: localStorage, cookies, IndexedDB, database calls, API state — anything per-user that could live on a PDS instead.
- **Content creation**: Does the app let users create, edit, or save things? (posts, notes, drawings, settings, lists, bookmarks, etc.)
- **Existing routes**: How is the app structured? Would user-specific public pages make sense?

### Common integration patterns

Based on what you find, suggest the relevant patterns to the user:

1. **Replace localStorage/local data with PDS records** — If the app stores per-user data locally (localStorage, IndexedDB, cookies), store it as AT Protocol records on the user's PDS instead. The data becomes portable and accessible from any app that speaks AT Protocol. **Important: data on a PDS is public.** Make this very clear to the user — if the app currently stores private data locally, moving it to a PDS makes it visible to anyone. Only suggest this for data the user would be comfortable sharing publicly.

2. **Add public `/{actor}` profile routes** — If each user produces content, add a route like `/{actor}` (where `actor` is a handle like `alice.bsky.social` or a DID) that displays that user's records. The logged-in user manages their own data from the main UI; anyone can view anyone else's public data by visiting their route. This is a natural fit when replacing localStorage — what was private per-device data becomes a public, shareable profile.

3. **Social interactions** — Add likes, reposts, follows, or other social features using existing AT Protocol / Bluesky lexicons (`app.bsky.feed.like`, `app.bsky.graph.follow`, etc.).

4. **Content publishing** — If the app produces content (posts, articles, images, media), publish to the user's PDS under a custom collection namespace.

5. **Auth only** — Just add login/logout. The app doesn't read or write AT Protocol records — it only needs to know who the user is.

Present your analysis and a concrete proposal (e.g. "I'd suggest replacing the localStorage todos with records in a `xyz.yourdomain.todo` collection, and adding a `/{actor}` route so users can share their list publicly"). **Wait for the user's response** before continuing to Step 1.

## Step 1: Ask configuration questions

Once the integration approach is agreed on, ask the user:

1. **UI**: Should I add a login UI?
   - **`foxui`** — Use `@foxui/social` login modal (polished, recommended)
   - **`basic`** — Simple login/logout page at `/user` route (uses Tailwind if available)
   - **`none`** — Backend only, no UI (you'll build your own)

2. **Collections**: What AT Protocol collections should your app write to? (e.g. `xyz.statusphere.status`, `app.bsky.feed.like`). Leave empty for read-only. (You should already have a suggestion from Step 0.)

3. **Blobs**: Does the app need to upload blobs (images, video)? If yes, what types? (e.g. `image/*`, `video/*`)

4. **Signup**: Should the app allow users to create new AT Protocol accounts (signup)?
   - **`yes`** — Include a signup button/flow
   - **`no`** — Login only, no account creation

5. **Production PDS**: Which PDS should be used for signup in production? (default: `https://selfhosted.social/`)
   - Only relevant if signup is enabled. Skip if signup is `no`.

Use the answers to customize `settings.ts` (marked with `CUSTOMIZE` below) and choose which UI dependencies/files to create.

## Step 2: Install dependencies

Always install:

```sh
pnpm add valibot
pnpm add -D @atcute/oauth-node-client @atcute/identity-resolver @atcute/lexicons @atcute/client @atcute/tid @cloudflare/workers-types tsx @atcute/atproto @atcute/bluesky
```

If UI choice is `foxui`:

```sh
pnpm add @foxui/social @foxui/core
```

## Step 3: Create files

### Download all files

Run this bash script to download all required files into the project:

```sh
BASE_URL="https://raw.githubusercontent.com/flo-bit/svelte-cloudflare-statusphere/main"

FILES=(
  "src/lib/atproto/auth.svelte.ts"
  "src/lib/atproto/methods.ts"
  "src/lib/atproto/image-helper.ts"
  "src/lib/atproto/port.ts"
  "src/lib/atproto/index.ts"
  "src/lib/atproto/server/signed-cookie.ts"
  "src/lib/atproto/server/kv-store.ts"
  "src/lib/atproto/server/oauth.ts"
  "src/lib/atproto/server/oauth.remote.ts"
  "src/lib/atproto/server/repo.remote.ts"
  "src/lib/atproto/server/session.ts"
  "src/lib/atproto/server/profile.ts"
  "src/lib/atproto/scripts/generate-key.ts"
  "src/lib/atproto/scripts/generate-secret.ts"
  "src/lib/atproto/scripts/setup-dev.ts"
  "src/lib/atproto/scripts/tunnel.ts"
  "src/routes/(oauth)/oauth/callback/+server.ts"
  "src/routes/(oauth)/oauth/jwks.json/+server.ts"
  "src/routes/(oauth)/oauth-client-metadata.json/+server.ts"
  ".env.example"
)

for file in "${FILES[@]}"; do
  mkdir -p "$(dirname "$file")"
  curl -fsSL "$BASE_URL/$file" -o "$file"
  echo "  downloaded $file"
done
```

### `src/lib/atproto/settings.ts`

**Do not fetch this file.** Create it manually using the template below, customized with the user's answers:

```ts
import { dev } from '$app/environment';
import { scope } from '@atcute/oauth-node-client';

// CUSTOMIZE: writable collections
export const collections = [] as const;

export type AllowedCollection = (typeof collections)[number];

// CUSTOMIZE: OAuth scope — add scope.blob({ accept: ['image/*'] }), scope.rpc(), etc. as needed
export const scopes = ['atproto', scope.repo({ collection: [...collections] })];

// CUSTOMIZE: set to true to allow signup, false for login-only
export const ALLOW_SIGNUP = true;

// CUSTOMIZE: PDS to use for signup (only relevant if ALLOW_SIGNUP is true)
const devPDS = 'https://bsky.social/';
const prodPDS = 'https://selfhosted.social/'; // CUSTOMIZE: change to preferred production PDS
export const signUpPDS = dev ? devPDS : prodPDS;

export const REDIRECT_PATH = '/oauth/callback';

// redirect the user back to the page they were on before login
export const REDIRECT_TO_LAST_PAGE_ON_LOGIN = true;

export const DOH_RESOLVER = 'https://mozilla.cloudflare-dns.com/dns-query';
```

## Step 4: Modify existing files

### `src/app.d.ts`

Add these to the existing `App` namespace. Merge with any existing `Locals` or `Platform` fields — do not remove existing fields.

```ts
import type { OAuthSession } from '@atcute/oauth-node-client';
import type { Client } from '@atcute/client';
import type { Did } from '@atcute/lexicons';
```

Add to `App.Locals`:

```ts
session: OAuthSession | null;
client: Client | null;
did: Did | null;
```

Add to `App.Platform`:

```ts
env: {
  OAUTH_SESSIONS: KVNamespace;
  OAUTH_STATES: KVNamespace;
  CLIENT_ASSERTION_KEY: string;
  COOKIE_SECRET: string;
  OAUTH_PUBLIC_URL: string;
  PROFILE_CACHE?: KVNamespace;
};
```

Add at the bottom of the file (for lexicon type augmentation):

```ts
import type {} from '@atcute/atproto';
import type {} from '@atcute/bluesky';
```

### `src/hooks.server.ts`

Add session restoration. If the file already has a `handle` export, wrap both in `sequence()` from `@sveltejs/kit`.

```ts
import type { Handle } from '@sveltejs/kit';
import { restoreSession } from '$lib/atproto/server/session';

const atprotoHandle: Handle = async ({ event, resolve }) => {
  const { session, client, did } = await restoreSession(
    event.cookies, event.platform?.env
  );
  event.locals.session = session;
  event.locals.client = client;
  event.locals.did = did;
  return resolve(event);
};
```

If no existing hooks: `export const handle = atprotoHandle;`

If existing hooks: `export const handle = sequence(existingHandle, atprotoHandle);` (import `sequence` from `@sveltejs/kit`)

### `src/routes/+layout.server.ts`

Add profile loading. Merge with any existing load function.

```ts
import type { LayoutServerLoad } from './$types';
import { loadProfile } from '$lib/atproto/server/profile';

export const load: LayoutServerLoad = async ({ locals, platform }) => {
  if (!locals.did) return { did: null, profile: null };
  const profile = await loadProfile(locals.did, platform?.env?.PROFILE_CACHE);
  return { did: locals.did, profile };
};
```

If a load function already exists, merge the profile data into its return value.

### `src/routes/+layout.svelte` (foxui only)

Only if the user chose `foxui`. Add the login modal to the existing layout.

If signup is enabled (`ALLOW_SIGNUP = true`):

```svelte
<script lang="ts">
  import { AtprotoLoginModal } from '@foxui/social';
  import { login, signup } from '$lib/atproto';
</script>

<!-- keep existing layout content, add this at the bottom: -->
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

If signup is disabled (`ALLOW_SIGNUP = false`), omit the `signup` prop:

```svelte
<script lang="ts">
  import { AtprotoLoginModal } from '@foxui/social';
  import { login } from '$lib/atproto';
</script>

<AtprotoLoginModal
  login={async (handle) => {
    await login(handle);
    return true;
  }}
/>
```

To show the modal from anywhere, use `@foxui/social` state and `@foxui/core` components:

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

`@foxui/core` also exports `Avatar`, `Input`, and other UI primitives you can use.

### `src/routes/user/+page.svelte` (basic only)

Only if the user chose `basic`. Create this file:

```svelte
<script lang="ts">
  import { user, login, logout } from '$lib/atproto';

  let handle = $state('');
  let error = $state('');
  let loading = $state(false);

  async function handleLogin() {
    if (!handle.trim()) return;
    loading = true;
    error = '';
    try {
      await login(handle);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Login failed';
      loading = false;
    }
  }
</script>

<div class="mx-auto max-w-sm p-8">
  {#if user.isLoggedIn}
    <p class="mb-4">Signed in as <strong>{user.profile?.handle ?? user.did}</strong></p>
    <button
      class="rounded bg-red-600 px-4 py-2 text-white hover:bg-red-700"
      onclick={() => logout()}
    >
      Sign Out
    </button>
  {:else}
    <h1 class="mb-4 text-xl font-bold">Sign in</h1>
    <form onsubmit={handleLogin} class="flex flex-col gap-3">
      <input
        type="text"
        bind:value={handle}
        placeholder="handle.bsky.social"
        class="rounded border px-3 py-2"
        disabled={loading}
      />
      {#if error}
        <p class="text-sm text-red-600">{error}</p>
      {/if}
      <button
        type="submit"
        class="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
        disabled={loading || !handle.trim()}
      >
        {loading ? 'Signing in...' : 'Sign In'}
      </button>
    </form>
  {/if}
</div>
```

If the project does not use Tailwind, replace the Tailwind classes with plain inline styles.

### `svelte.config.js`

Add `remoteFunctions: true` inside `kit.experimental`:

```js
kit: {
  adapter: adapter(),
  experimental: {
    remoteFunctions: true
  }
}
```

If `experimental` already exists, merge into it. Do not remove other experimental flags.

### `vite.config.ts`

Add the port import and dev server config for loopback OAuth:

```ts
import { DEV_PORT } from './src/lib/atproto/port';
```

```ts
server: {
  host: '127.0.0.1',
  port: DEV_PORT
}
```

Add these inside `defineConfig()`. Do not remove existing plugins or config.

### `wrangler.jsonc`

Add or merge these fields:

- Ensure `"main"` is set to the SvelteKit Cloudflare worker entrypoint:

```jsonc
"main": ".svelte-kit/cloudflare/_worker.js"
```

- Ensure `"assets"` is configured:

```jsonc
"assets": {
  "binding": "ASSETS",
  "directory": ".svelte-kit/cloudflare"
}
```

- Add `"nodejs_compat_v2"` to `compatibility_flags` (create the array if it doesn't exist)
- Do NOT add `OAUTH_PUBLIC_URL` to vars — it is only needed for production deployment and the user will set it themselves later. In dev mode without it, the app uses a loopback client automatically.
- Add KV namespace placeholders to `kv_namespaces`. Use the project name (from the `"name"` field in `wrangler.jsonc` or `package.json`) as a prefix so namespaces are distinguishable when multiple projects share the same Cloudflare account:

```jsonc
{ "binding": "OAUTH_SESSIONS", "id": "TODO" },
{ "binding": "OAUTH_STATES", "id": "TODO" }
```

Do not remove existing bindings or vars.

### `tsconfig.json`

Add `"@cloudflare/workers-types"` to `compilerOptions.types`. Create the `types` array if it doesn't exist.

### `package.json`

Add these to the `scripts` section:

```json
"env:generate-key": "npx tsx src/lib/atproto/scripts/generate-key.ts",
"env:generate-secret": "npx tsx src/lib/atproto/scripts/generate-secret.ts",
"env:setup-dev": "npx tsx src/lib/atproto/scripts/setup-dev.ts",
"tunnel": "npx tsx src/lib/atproto/scripts/tunnel.ts"
```

### `.gitignore`

Ensure these lines are present:

```
.env
.env.*
!.env.example
```

## Step 5: Run setup and verify

1. Run `pnpm env:setup-dev` to generate secrets in `.env` and assign a random dev port (5200–7200) in `port.ts`
2. Run `pnpm dev` to start the dev server
3. Verify it starts on `http://127.0.0.1:<DEV_PORT>` (the port from `port.ts`)
4. Tell the user:
   - Dev mode uses a loopback client (no keys needed)
   - For production: create KV namespaces prefixed with the project name — e.g. `npx wrangler kv namespace create <project-name>-OAUTH_SESSIONS` and `<project-name>-OAUTH_STATES` (use the `name` from `wrangler.jsonc`). Update the IDs in `wrangler.jsonc`, set `OAUTH_PUBLIC_URL` to their domain, and run `npx wrangler secret put CLIENT_ASSERTION_KEY` / `COOKIE_SECRET` with values from `pnpm env:generate-key` / `pnpm env:generate-secret`

## Tunnel (for testing OAuth with a public URL)

In dev mode, OAuth works via loopback (no public URL needed). But if you need to test with a real public URL (e.g. testing from another device, or testing production-like OAuth flows), use the tunnel command:

```sh
pnpm tunnel
```

This requires `cloudflared` to be installed. It:
1. Spawns a Cloudflare Quick Tunnel pointing to `http://localhost:<DEV_PORT>`
2. Sets `OAUTH_PUBLIC_URL` in `.env` to the tunnel URL
3. Adds the tunnel hostname to `allowedHosts` in `vite.config.ts`
4. Shows a persistent status bar with the tunnel URL

After starting the tunnel, restart the dev server (`pnpm dev`) to pick up the new URL. When you stop the tunnel (Ctrl+C), it automatically cleans up `.env` and `vite.config.ts`.

## Usage examples

### Login / Logout

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
import { putRecord, deleteRecord, uploadBlob, createTID } from '$lib/atproto';

await putRecord({
  collection: 'your.collection.name',
  rkey: createTID(),
  record: { text: 'hello', createdAt: new Date().toISOString() }
});

await deleteRecord({ collection: 'your.collection.name', rkey: 'some-key' });

const blob = await uploadBlob({ blob: file });
// For images, returns: { $type: 'blob', ref: { $link: string }, mimeType: string, size: number, aspectRatio: { width, height } }
// aspectRatio is auto-detected for image/* blobs, or you can pass it explicitly:
// await uploadBlob({ blob: file, aspectRatio: { width: 2000, height: 1144 } })

// Store the blob reference in a record
await putRecord({
  collection: 'your.collection.name',
  rkey: createTID(),
  record: { image: blob, createdAt: new Date().toISOString() }
});
```

### Displaying blobs

```ts
import { getBlobURL, getCDNImageBlobUrl } from '$lib/atproto';

// Option 1: Direct PDS URL (works for any blob type)
const url = await getBlobURL({ did: 'did:plc:...', blob: record.image });

// Option 2: Bluesky CDN URL (faster, cached, image-only, returns WebP thumbnails)
const cdnUrl = getCDNImageBlobUrl({ did: 'did:plc:...', blob: record.image });
```

### Image compression helper

The `image-helper.ts` module provides utilities for working with image blobs:

```ts
import { compressImage, checkAndUploadImage, getImageFromRecord } from '$lib/atproto/image-helper';

// Compress an image before uploading (default: max 900KB, max 2048px dimension, outputs WebP)
const { blob: compressedBlob, aspectRatio } = await compressImage(file);
const uploaded = await uploadBlob({ blob: compressedBlob });

// Or use checkAndUploadImage to handle compression + upload in one step
// Works with File objects, string URLs (with an image proxy), or already-uploaded blob refs
const record = { image: someFileOrUrl };
await checkAndUploadImage(record, 'image', '/api/image-proxy?url=');

// Get a display URL from a record's blob field (handles blob refs, object URLs, and strings)
const displayUrl = getImageFromRecord(record, did, 'image');
```

### Read operations (no auth needed)

```ts
import { listRecords, getRecord, getDetailedProfile } from '$lib/atproto';

const records = await listRecords({ did: 'did:plc:...', collection: 'your.collection.name' });
const profile = await getDetailedProfile({ did: 'did:plc:...' });
```
