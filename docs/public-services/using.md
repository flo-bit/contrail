# Using a public Contrail service

A public Contrail service is a typed, read-through API over public AT Protocol records. This guide uses `https://api.atmo.rsvp`; replace it with the provider you want to use.

## Install and connect

```bash
pnpm add @atcute/client @atcute/lexicons @atmo-dev/contrail
pnpx @atmo-dev/contrail connect https://api.atmo.rsvp
```

`connect` validates the provider description and content-addressed Lexicon bundle, writes a version-2 `contrail.lock.json`, and generates:

```text
lex.config.js
src/contrail/
  index.ts
  lexicons/
  types/
```

The generated configuration contains everything needed to identify the service and generate its types:

```js
export default {
  contrail: {
    endpoint: "https://api.atmo.rsvp",
    serviceDid: "did:web:api.atmo.rsvp",
    scope: "rpc?lxm=*&aud=did:web:api.atmo.rsvp",
    collections: [
      "app.bsky.actor.profile",
      "app.bsky.graph.follow",
      "community.lexicon.calendar.event",
      "community.lexicon.calendar.rsvp",
    ],
  },
  generate: {
    files: ["src/contrail/lexicons/**/*.json"],
    outdir: "src/contrail/types/",
  },
};
```

For JavaScript output, choose a `.js` client path:

```bash
pnpx @atmo-dev/contrail connect https://api.atmo.rsvp \
  --client src/contrail/index.js
```

Commit `contrail.lock.json` and the generated files.

When the application owns or can read the provider config, connect directly to that source before a deployment exists:

```bash
pnpx @atmo-dev/contrail connect ../api/src/contrail.config.ts
pnpx @atmo-dev/contrail dev --config ../api/src/contrail.config.ts
```

The config connection compiles Lexicons and types without creating or modifying `contrail.lock.json`. `contrail dev` only runs the loopback service. The generated module exports `createLocalContrailClient()`:

```ts
import {
  contrail as productionContrail,
  createLocalContrailClient,
} from "./contrail/index.js";

export const contrail = process.env.CONTRAIL_URL
  ? createLocalContrailClient(process.env.CONTRAIL_URL)
  : productionContrail;
```

The helper permits HTTP only for `localhost`, `127.0.0.1`, or `[::1]` and does not inherit a production service-auth audience. Local notification and configured protected methods are loopback-only operations with a null OAuth scope. A deployed service still requires HTTPS and its real service auth.

## Query anonymous methods

```ts
import { contrail } from "./contrail/index.js";

const response = await contrail.get("rsvp.atmo.event.listRecords", {
  params: {
    limit: 20,
    sort: "startsAt",
    order: "asc",
    profiles: true,
  },
});

if (!response.ok) {
  throw new Error(`Contrail query failed: ${response.status}`);
}

for (const event of response.data.records) {
  console.log(event.value.name, event.value.startsAt);
}
```

The generated Lexicons provide typed method names, parameters, and responses.

## Use one authenticated client

Add the provider's generated scope to the application's OAuth scopes:

```ts
import { contrail } from "./contrail/index.js";

export const scopes = ["atproto", contrail.scope];
```

After login, combine Contrail with the existing authenticated AT Protocol client:

```ts
const client = contrail.authenticated(authenticatedClient, {
  onNotificationError(error, { uris }) {
    console.warn("Contrail notification failed", uris, error);
  },
});

const response = await client.get("rsvp.atmo.getFeed", {
  params: {
    feed: "network",
    actor: signedInDid,
    collection: "community.lexicon.calendar.event",
    profiles: true,
    limit: 20,
  },
});
```

The same client still handles ordinary PDS calls. Successful writes to connected collections automatically notify Contrail:

```ts
await client.post("com.atproto.repo.createRecord", {
  input: {
    repo: signedInDid,
    collection: "community.lexicon.calendar.event",
    record: event,
  },
});
```

Contrail returns the original PDS response. A notification failure is reported through `onNotificationError` but never turns a committed PDS write into a failed write. Handle-form `deleteRecord` inputs are resolved through the PDS to construct the canonical DID record URI before notification. The login session remains application-owned.

## Update the connection

Anonymous generated clients call the endpoint directly without fetching discovery first. Protected calls lazily discover service auth; transient discovery failures remain retryable and endpoint or service-DID mismatches fail closed. Adding provider methods does not interrupt methods already known by a generated client. Regenerate when application code wants the new API surface:

```bash
pnpx @atmo-dev/contrail connect https://api.atmo.rsvp --update
```

Review changes to `contrail.lock.json`, `lex.config.js`, and `src/contrail/`, then run the application's typecheck and tests. `--update` cannot repoint an existing lock or abandon its provider-owned Lexicon root; remove the existing connection deliberately before switching providers or output roots. Version-1 provider locks are intentionally unsupported after the clean manifest-v2 cut and must be removed before reconnecting.

## Completeness

A public Contrail service is a shared, possibly incomplete read-through cache. Reads may fetch missing public records or profiles, but an empty result does not prove that no matching record exists on the network.

Applications still authenticate users and publish records through their PDS. Contrail service auth only authorizes the protected methods advertised by that service.
