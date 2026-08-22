# Atmo Circle demo

An integrated SvelteKit + Contrail Spaces-alpha application with PDS-native membership. One Cloudflare Worker owns the OAuth sessions, private projection, synchronization jobs, and browser delivery path.

- OAuth sessions live in the application's KV namespaces through `@svelte-atproto/oauth`.
- Trusted server code passes `locals.did` directly to the in-process Spaces runtime; user-facing calls do not mint AT service-auth JWTs.
- Owners manage members through native `com.atproto.simplespace` procedures.
- Successful delegation creates a short query lease against the PDS-owned policy.
- Writes go directly to each user's permissioned PDS repo and schedule nonfatal projection synchronization in-process.
- Reads query the Worker-bound D1 projection directly.
- A short-lived ticket opens a Durable Object WebSocket for invalidations, with a 30-second foreground refresh fallback.
- Standard PDS `notifyWrite` and deletion callbacks remain service-authenticated at `spaces.atmo.garden`.

Only Spaces-compatible PDS accounts can use the alpha. Browser invalidations never contain private records.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, generate the OAuth secrets, and generate a 32-byte base64 credential-encryption key. Then run:

```sh
pnpm --filter @atmo-dev/contrail-spaces-alpha build
pnpm --filter contrail-spaces-demo dev
```

Wrangler runs local KV, D1, Queue, and Durable Object bindings. Consumer writes call the integrated synchronization API, so a publicly reachable notification callback is not required. PDS notification registration is best-effort and periodic reconciliation remains the recovery path.

## Production

`wrangler.jsonc` binds the application to the production D1 database, Queue, Durable Object, and OAuth KV namespaces. Install these secrets:

```sh
pnpm exec atproto-oauth secret | pnpm exec wrangler secret put COOKIE_SECRET
pnpm exec atproto-oauth keygen | pnpm exec wrangler secret put CLIENT_ASSERTION_KEY
openssl rand -base64 32 | pnpm exec wrangler secret put SPACES_CREDENTIAL_ENCRYPTION_KEY
```

Deploy the integrated Worker:

```sh
pnpm --filter @atmo-dev/contrail-spaces-alpha build
pnpm --filter contrail-spaces-demo deploy
```

The application is served at `https://circle.atmo.garden`; `https://spaces.atmo.garden` remains the resolvable service identity for standard PDS callbacks.
