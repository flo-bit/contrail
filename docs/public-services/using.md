# Using a public Contrail service

A public Contrail service is a typed, read-through API over public AT Protocol records. This guide uses `https://api.atmo.rsvp`; replace it with the provider you want to use.

## Install and connect

```bash
pnpm add @atcute/client @atcute/lexicons @atmo-dev/contrail
pnpx @atmo-dev/contrail connect https://api.atmo.rsvp
```

`connect` verifies the provider's contract and Lexicons, writes `contrail.lock.json`, and generates:

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

For a local service, run `contrail dev` in the consumer project. It automatically follows the same discovery, digest verification, Lexicon download, Atcute type generation, contract lock, and generated-client path against `http://127.0.0.1:8787`. Svelte projects use `src/lib/contrail/`; pass `--no-connect` to disable generation. The generated client includes `allowInsecureHttp: true`, an exception accepted only for `localhost`, `127.0.0.1`, or `[::1]`.

When local dev supplies the otherwise omitted notify configuration, notification is an open loopback operation rather than fictitious AT Protocol service auth. The generated client's `scope` is therefore `null`; keep only normal repository permissions in local OAuth configuration. A deployed service still requires HTTPS and a real service DID for protected operations.

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

The generated client pins the lock's contract digest and verifies discovery before its first provider request. Transient discovery failures remain retryable; endpoint, service-DID, and contract mismatches fail closed. Update a changed contract deliberately at the same provider endpoint:

```bash
pnpx @atmo-dev/contrail connect https://api.atmo.rsvp --update
```

Review changes to `contrail.lock.json`, `lex.config.js`, and `src/contrail/`, then run the application's typecheck and tests. `--update` cannot repoint an existing lock or abandon its provider-owned Lexicon root; remove the existing connection deliberately before switching providers or output roots.

## Completeness

A public Contrail service is a shared, possibly incomplete read-through cache. Reads may fetch missing public records or profiles, but an empty result does not prove that no matching record exists on the network.

Applications still authenticate users and publish records through their PDS. Contrail service auth only authorizes the protected methods advertised by that service.
