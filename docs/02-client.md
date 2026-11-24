# Add the typed client

## Same repo / monorepo

When your app has access to `contrail.config.ts`, install Contrail and Atcute and generate the AppView Lexicons and TypeScript types directly:

```bash
pnpm add @atmo-dev/contrail @atcute/client @atcute/lexicons
pnpm contrail lexicons all
# or point at a sibling AppView config:
pnpm contrail lexicons all --config ../my-appview/contrail.config.ts
```

`contrail lexicons all` generates your AppView XRPC Lexicons into `lexicons/generated/`, pulls referenced source Lexicons, and runs Atcute type generation into `src/lexicon-types/`.

## Separate consumer app (deployed AppView)

When connecting to a deployed AppView without local access to `contrail.config.ts`, pull its published Lexicon bundle from its discovery manifest:

1. Fetch `GET https://my-appview.example.com/.well-known/contrail`. The manifest returns `endpoint`, `lexicons.url`, `collections`, and (when service auth is enabled) `serviceAuth` (`serviceDid`, `audience`, `scope`, `methods`).
2. Fetch `lexicons.url` and write each document in `bundle.lexicons` to `src/contrail/lexicons/<nsid-path>.json` (for example `com/example/event/listRecords.json`).
3. Point `lex.config.js` at those files and generate ambient types with `@atcute/lex-cli`:

```js
// lex.config.js
export default {
  generate: {
    files: ["src/contrail/lexicons/**/*.json"],
    outdir: "src/lexicon-types/",
  },
};
```

```bash
pnpx @atcute/lex-cli generate
```

## Query records

Import the generated ambient types once so `@atcute/client` knows your AppView's XRPC methods:

```ts
import type {} from "./lexicon-types/index.js";
import { createPublicServiceClient } from "@atmo-dev/contrail/client";

const contrail = createPublicServiceClient({
  endpoint: "https://my-appview.example.com",
  // For local `contrail dev`, pass:
  // endpoint: "http://127.0.0.1:8787",
  // allowInsecureHttp: true,
});

const res = await contrail.get("com.example.event.listRecords", {
  params: {
    startsAtMin: new Date().toISOString(),
    limit: 20,
  },
});

if (!res.ok) throw new Error(`Contrail returned ${res.status}`);

for (const event of res.data.records) {
  console.log(event.value.name, event.value.startsAt);
}
```

### Protected methods (service auth)

If the AppView protects methods (such as `getFeed` or `notifyOfUpdate`) with AT Protocol service auth, pass the values from `manifest.serviceAuth` (`/.well-known/contrail`) to `createPublicServiceClient` and request `serviceAuth.scope` during OAuth sign-in:

```ts
const contrail = createPublicServiceClient({
  endpoint: "https://my-appview.example.com",
  serviceDid: "did:web:my-appview.example.com",
  serviceAudience: "did:web:my-appview.example.com#contrail",
  scope: "rpc?aud=did:web:my-appview.example.com%23contrail&lxm=com.example.notifyOfUpdate",
  protectedMethods: ["com.example.notifyOfUpdate"],
});

const authed = contrail.authenticated(pdsClient);
```

## Notify after writes

If your AppView enables `notify: true` (or `notify` with service auth), call `notifyOfUpdate` after writing a record to a user's PDS so it indexes immediately without waiting for Jetstream:

```ts
await contrail.post("com.example.notifyOfUpdate", {
  input: { uris: [createdRecordUri] },
});
```

## Updating

Re-run `pnpm contrail lexicons all` whenever `contrail.config.ts` changes (or re-fetch `/.well-known/contrail` + `lexicons.url` and re-run `@atcute/lex-cli generate` for a separate consumer app). Use `pnpm contrail lexicons check` in CI to verify generated Lexicons stay in sync.

Next: [Configure and query](./03-configure-and-query.md).
