# Getting Started

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (for production)

## Local Development

```sh
pnpm install
pnpm dev
```

That's it. In dev mode the app uses a loopback OAuth client — no keys, no Cloudflare setup, no secrets. It binds to `127.0.0.1` on the port defined in `src/lib/atproto/port.ts` (required for AT Protocol loopback OAuth).

Open the URL shown in the terminal and log in with any Bluesky handle.

## Configure your app

Edit `src/lib/atproto/settings.ts` to set the collections your app reads/writes:

```ts
export const permissions = {
  collections: ['xyz.statusphere.status'],
  rpc: {},
  blobs: []
} as const;
```

The OAuth scope is auto-generated from this config.

## Deploy to Production

### 1. Create KV namespaces

Prefix namespace names with your project name (the `name` field in `wrangler.jsonc`) so they're easy to identify when you have multiple projects on the same Cloudflare account:

```sh
npx wrangler kv namespace create <project-name>-OAUTH_SESSIONS
npx wrangler kv namespace create <project-name>-OAUTH_STATES
```

Each command outputs an ID. Put them in `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "OAUTH_SESSIONS", "id": "<your-id>" },
  { "binding": "OAUTH_STATES", "id": "<your-id>" }
]
```

### 2. Set your public URL

In `wrangler.jsonc`, set `OAUTH_PUBLIC_URL` to your production domain:

```jsonc
"vars": {
  "OAUTH_PUBLIC_URL": "https://your-domain.com"
}
```

### 3. Generate and set secrets

```sh
pnpm env:generate-key
npx wrangler secret put CLIENT_ASSERTION_KEY    # paste the output

pnpm env:generate-secret
npx wrangler secret put COOKIE_SECRET           # paste the output
```

### 4. Deploy

```sh
npx wrangler deploy
```

Then add a custom domain in the Cloudflare dashboard (Worker > Settings > Domains & Routes).

## Dev with tunnel (optional)

To test the full confidential client flow locally using [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```sh
pnpm env:setup-dev                              # generates secrets in .env + random port
pnpm tunnel                                     # start tunnel (uses port from port.ts)
```

Add the tunnel URL to `.env`:

```
OAUTH_PUBLIC_URL=https://your-tunnel-id.trycloudflare.com
```

Then `pnpm dev`. The app will use a confidential client with that URL.

## Scripts

| Script | Description |
|---|---|
| `pnpm dev` | Start dev server |
| `pnpm build` | Build for production |
| `pnpm check` | Run svelte-check |
| `pnpm env:generate-key` | Generate client assertion key |
| `pnpm env:generate-secret` | Generate cookie signing secret |
| `pnpm env:setup-dev` | Generate secrets, write to `.env`, assign random dev port |
| `pnpm tunnel` | Start a Cloudflare tunnel for testing OAuth with a public URL |

## Optional: Profile caching

Create a KV namespace for caching Bluesky profiles (1 hour TTL):

```sh
npx wrangler kv namespace create PROFILE_CACHE
```

Add it to `wrangler.jsonc` alongside the other namespaces:

```jsonc
{ "binding": "PROFILE_CACHE", "id": "<your-id>" }
```

Without this, profiles are fetched fresh on every page load. The app works fine either way.
