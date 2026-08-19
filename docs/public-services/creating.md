# Creating a public Contrail service

A public Contrail service lets independent applications query one Contrail AppView from a stable HTTPS origin. The provider chooses the indexed collections, projections, query methods, and authentication policy. Consumers discover that API surface, verify its Lexicons, generate local TypeScript types, and make ordinary XRPC requests.

Public service mode does not turn Contrail into a PDS. Records remain in their authors' repositories, and applications still authenticate users and publish writes through those users' PDSes.

## Define the index

Start with a normal Contrail configuration:

```ts
// src/contrail.config.ts
import type { ContrailConfig } from "@atmo-dev/contrail";

export const config: ContrailConfig = {
  namespace: "events.example",
  orderedSource: {
    source: "jetstream",
    epoch: "primary-2026-08",
  },
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: {
        mode: {},
        startsAt: { type: "range" },
      },
      searchable: ["name", "description"],
    },
  },
};
```

The namespace becomes the prefix of generated methods such as:

```text
events.example.getCursor
events.example.event.getRecord
events.example.event.listRecords
```

Use one stable `orderedSource.epoch` for one continuity history. Change the epoch when the Jetstream endpoint set, retention assumptions, or cursor meaning changes. Consumers treat a source or epoch change as a full-refetch boundary.

## Generate the public Lexicons

Add Atcute's generator configuration:

```js
// lex.config.js
import { defineLexiconConfig } from "@atcute/lex-cli";

export default defineLexiconConfig({
  generate: {
    files: [
      "lexicons/custom/**/*.json",
      "lexicons/pulled/**/*.json",
      "lexicons/generated/**/*.json",
    ],
    outdir: "src/lexicon-types/",
  },
});
```

Generate the provider API, pull referenced record Lexicons, and generate TypeScript types:

```bash
pnpm contrail lexicons all --public
```

Check generated drift in CI:

```bash
pnpm contrail lexicons check --public
```

The public surface includes anonymous queries plus explicitly configured service-auth queries and procedures. Private full-surface procedures are not included merely because they exist in application code.

## Publish discovery from a Worker

Pass the generated documents and canonical HTTPS origin to `createWorker`:

```ts
// src/worker.ts
import { createWorker } from "@atmo-dev/contrail/worker";
import { lexicons } from "../lexicons/generated";
import { config } from "./contrail.config";

export default createWorker(config, {
  lexicons,
  publicService: {
    endpoint: "https://api.example.com",
  },
});
```

This publishes:

```text
GET /.well-known/contrail
GET /lexicons
GET /lexicons/<sha256-digest>
GET /status
```

The version-2 discovery manifest contains the endpoint, namespace, methods, collections, service-auth declaration, and a content-addressed Lexicon bundle. It does not hash the complete method set. Startup still fails when advertised methods, capabilities, and bundled Lexicons disagree, and the immutable Lexicon URL retains its digest.

The public `/status` response contains aggregate readiness and freshness information. It omits DIDs, record bodies, source cursors, raw upstream errors, and other private operational details.

## Anonymous read-through methods

Collection queries, `getCursor`, profiles, feeds, and authored custom queries are anonymous unless explicitly protected. An anonymous query may still improve the shared cache by:

- resolving an actor;
- fetching a missing public record from its PDS;
- populating profile or feed projections; or
- running a trusted custom query handler.

This is read-through acquisition, not a caller-controlled write API. Only configured collections and trusted provider code can affect the projection.

## Protecting feeds and notifications with service auth

AT Protocol service auth lets any suitably authorized AT Protocol client call selected methods without distributing a shared application secret.

```ts
export const config: ContrailConfig = {
  namespace: "events.example",
  notify: true,
  serviceAuth: {
    audience: "did:web:api.example.com",
    methods: ["getFeed", "notifyOfUpdate"],
  },
  collections,
  feeds: {
    network: {
      targets: [{ collection: "event", maxItems: 100 }],
    },
  },
};
```

The provider verifies:

- the JWT signature against the issuer DID's `#atproto` key;
- the exact audience DID;
- the token's exact `lxm` method claim;
- expiration and maximum token age; and
- the route-specific ownership rule.

For protected feeds, the requested actor must resolve to the token issuer. For `notifyOfUpdate`, every submitted AT URI must belong to the token issuer. Notify still fetches the current authoritative record from that issuer's PDS; callers never submit a record body for Contrail to trust.

The default PLC/`did:web` resolver keeps a bounded five-minute in-process cache and deduplicates concurrent lookups. Signature failure forces an uncached refresh so key rotation does not remain hidden behind a stale entry. Deployments can still provide their own resolver policy.

The authenticated methods are listed separately from anonymous methods in discovery. Their query or procedure Lexicons remain in the provider bundle, so consumers still get generated types.

## Start from owned source

A consumer developed alongside the provider can generate its initial API surface before any deployment exists:

```bash
pnpx @atmo-dev/contrail connect ./src/contrail.config.ts
# or discover the standard config beneath another project directory
pnpx @atmo-dev/contrail connect ../api
```

This compiles the config directly, writes generated Lexicons and types, and exports local/target client factories. It does not create or modify `contrail.lock.json`. Run the service separately:

```bash
pnpx @atmo-dev/contrail dev --config ../api/src/contrail.config.ts
```

After deploying, `contrail connect https://api.example.com` creates the version-2 provider lock and makes that deployment the generated default target. Future config-source connections can refresh local API types without changing the production lock.

### OAuth permission versus token binding

A client can request one OAuth permission for all methods at this service:

```text
rpc?lxm=*&aud=did:web:api.example.com
```

The wildcard belongs to the OAuth scope. It avoids asking the user for one scope per method. Each call to `com.atproto.server.getServiceAuth` should still pass the specific method NSID as `lxm`, producing a short-lived method-bound token.

For example, a feed token uses:

```text
lxm=events.example.getFeed
```

and cannot be reused for:

```text
lxm=events.example.notifyOfUpdate
```

### Service DID

When the service-auth audience matches the public origin, such as:

```text
did:web:api.example.com
https://api.example.com
```

Contrail publishes the service DID document at:

```text
https://api.example.com/.well-known/did.json
```

The service DID is the stable JWT audience. The AppView does not need a signing key merely to receive and verify user-issued service tokens.

## Profiles and internal follow projections

Profiles can be enabled without exposing raw profile collection methods:

```ts
profiles: ["app.bsky.actor.profile"],
collections: {
  event,
  profile: {
    collection: "app.bsky.actor.profile",
    discover: false,
    methods: [],
  },
}
```

Likewise, a follow collection can remain an internal feed input:

```ts
follow: {
  collection: "app.bsky.graph.follow",
  discover: false,
  subjectField: "subject",
  methods: [],
}
```

`discover: false` prevents network-wide relay discovery for dependent collections. `subjectField: "subject"` excludes follows whose subject is outside the known acquisition scope. Those exclusions do not create tombstones.

Profiles can then appear through `getProfile` and `profiles=true` hydration, while follows power `getFeed` without creating a public social-graph directory.

## Runtime validation is explicit per collection

The deployment already ships one reviewed generated Lexicon bundle. Select which collection policies use it directly:

```ts
collections: {
  event: {
    collection: "community.lexicon.calendar.event",
    validate: true,
  },
  legacy: {
    collection: "community.example.legacy",
    // Omitted or false means no runtime validation.
  },
},
validation: {
  strict: true,
  verifyCid: true,
}
```

`createWorker(config, { lexicons })` binds the exact deployment bundle to opted-in collections; no second validation-specific array is needed. Validation applies across every acquisition source and startup fails if an opted-in record schema or transitive reference is absent. Collections without `validate: true` retain compatibility behavior.

## CORS

Public services allow browser requests and explicitly permit the `Authorization`, `Content-Type`, and `Atproto-Accept-Labelers` headers. Authentication failures expose `WWW-Authenticate` so browser clients can distinguish missing, expired, wrong-audience, and wrong-method tokens.

Never place a reusable application secret in browser code. AT Protocol service tokens are short-lived and minted for the authenticated user's DID.

## Provisioning and activation

Local development can use the normal local backfill command:

```bash
pnpm contrail backfill
```

For a substantial D1 production deployment, do not run a long bulk load through Wrangler's remote development proxy. Prefer a fresh generation:

1. capture the ordered-source replay boundary;
2. build canonical state in native SQLite;
3. leave unavailable accounts visibly pending, retrying, or failed;
4. catch up through the ordered source;
5. import canonical tables into a fresh D1 database;
6. rebuild FTS, relation counts, and other derived projections;
7. verify record/version consistency, status, discovery, and representative queries;
8. test the candidate through a non-production Worker; and
9. activate the matching Worker and D1 binding together.

Keep the previous D1 generation available for rollback. Do not split percentage traffic between independent databases with different serving positions.

## Provider checklist

Before announcing an origin:

- run public Lexicon drift checking and TypeScript typechecking;
- verify the manifest and Lexicon digests differ and both recompute correctly;
- verify every advertised method has a matching query or procedure Lexicon;
- verify protected methods reject missing, wrong-audience, and wrong-`lxm` tokens;
- verify feed actors and notify URIs are bound to the token issuer;
- verify browser CORS preflight with `Authorization`;
- verify `/status` contains no sensitive operational detail;
- verify `getCursor` reports the committed ordered-source position; and
- connect and compile an independent consumer project.
