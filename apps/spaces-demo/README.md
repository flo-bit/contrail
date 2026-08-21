# Atmo Circle demo

Small SvelteKit Cloudflare Worker demonstrating a separately deployed Contrail Spaces provider.

- OAuth sessions stay in this consumer's KV namespaces through `@svelte-atproto/oauth`.
- one-time delegation tokens are forwarded in authenticated request bodies;
- service-auth JWTs are minted per exact provider method;
- writes go directly to each user's permissioned PDS repo; and
- reads come from `https://spaces.atmo.garden`.

Only Spaces-compatible PDS accounts can use the alpha.

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
