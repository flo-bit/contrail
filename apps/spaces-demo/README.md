# Atmo Circle demo

Small SvelteKit Cloudflare Worker demonstrating a separately deployed Contrail Spaces provider with PDS-native membership.

- OAuth sessions stay in this consumer's KV namespaces through `@svelte-atproto/oauth`.
- one-time delegation tokens are forwarded in authenticated request bodies;
- service-auth JWTs are minted per exact provider method;
- owners add or remove members by handle through `com.atproto.simplespace`;
- short provider query leases are renewed on demand against the native PDS policy;
- an authenticated provider query lists circles the viewer owns or has connected through unexpired delegation evidence;
- writes go directly to each user's permissioned PDS repo;
- reads come from `https://spaces.atmo.garden`; and
- a short-lived provider ticket opens a WebSocket for projection invalidations, with a 30-second foreground refresh fallback.

Only Spaces-compatible PDS accounts can use the alpha. Clients refetch authorized query results after an invalidation; private records never travel in WebSocket events.

## Provision and deploy

Create two KV namespaces and put their IDs into `wrangler.jsonc`:

```sh
wrangler kv namespace create OAUTH_SESSIONS
wrangler kv namespace create OAUTH_STATES
```

Install OAuth secrets:

```sh
pnpx atproto-oauth secret | pnpm exec wrangler secret put COOKIE_SECRET
pnpx atproto-oauth keygen | pnpm exec wrangler secret put CLIENT_ASSERTION_KEY
```

Deploy the provider first, then:

```sh
pnpm --filter @atmo-dev/contrail-spaces-alpha build
pnpm --filter contrail-spaces-demo build
pnpm --filter contrail-spaces-demo deploy
```

The configured custom domain is `circle.atmo.garden`. OAuth metadata is served at `/oauth-client-metadata.json` by `@svelte-atproto/oauth`.
