# Atmo Circle provider

Standalone Contrail Spaces-alpha provider at `https://spaces.atmo.garden` (`did:web:spaces.atmo.garden#spaces`).

It indexes `garden.atmo.circle.note`, `garden.atmo.circle.member`, and `garden.atmo.circle.reaction` from one deterministic `garden.atmo.circle/self` Space per owner. The managing-app policy allows the owner and DIDs in the Space's member collection. Only membership records signed in the authority's repo are projected, so members cannot grant access to others. Policy failures deny access.

A hibernating Durable Object per Space fans out projection invalidations over one-time-ticket WebSockets. Events contain only the Space URI and timestamp; authorized clients refetch records through the private query API.

## Provision and deploy

```sh
wrangler d1 create contrail-spaces-demo
wrangler queues create contrail-spaces-demo
```

Put the returned D1 ID into `wrangler.jsonc`, then install the credential encryption secret:

```sh
openssl rand -base64 32 | pnpm exec wrangler secret put SPACES_CREDENTIAL_ENCRYPTION_KEY
```

Build the workspace packages and deploy:

```sh
pnpm --filter @atmo-dev/contrail build
pnpm --filter @atmo-dev/contrail-spaces-alpha build
pnpm --filter contrail-spaces-demo-provider typecheck
pnpm --filter contrail-spaces-demo-provider deploy
```

Verify discovery before deploying the consumer:

```sh
curl https://spaces.atmo.garden/.well-known/did.json
curl https://spaces.atmo.garden/.well-known/contrail-spaces-alpha
```

The Worker initializes its extension-owned D1 schema idempotently. No separate D1 migration command is needed for this first alpha schema. Wrangler applies the `SpaceSubscriptionHub` Durable Object migration declared in `wrangler.jsonc`.
