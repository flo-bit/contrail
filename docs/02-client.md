# Add the typed client

## Same repo / monorepo

When your app has access to `contrail.config.ts`, install Contrail and Atcute, generate Contrail's XRPC Lexicons, and run `@atcute/lex-cli` to pull source schemas and generate TypeScript types:

```bash
pnpm add @atmo-dev/contrail @atcute/client @atcute/lexicons
pnpm add -D @atcute/lex-cli
pnpm contrail lexicons generate
# or point at a sibling AppView config:
pnpm contrail lexicons generate --config ../my-appview/contrail.config.ts
```

Point your user-managed `lex.config.js` at `lexicons/generated/**/*.json` alongside your source Lexicons (listing upstream collection/profile NSIDs, plus `com.atproto.label.defs` / `com.atproto.repo.strongRef` if referenced, under `pull.sources`):

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
  pull: {
    outdir: "lexicons/pulled/",
    clean: true,
    sources: [
      {
        type: "atproto",
        mode: "nsids",
        nsids: [
          "app.bsky.actor.profile",
          "com.atproto.label.defs",
          "com.atproto.repo.strongRef",
          "community.lexicon.calendar.event",
        ],
      },
    ],
  },
});
```

Then pull upstream schemas (whenever collections change) and generate ambient TypeScript types:

```bash
pnpm exec lex-cli pull
pnpm exec lex-cli generate
```

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

Re-run `pnpm contrail lexicons generate` and `pnpm exec lex-cli generate` whenever `contrail.config.ts` changes (or re-fetch `/.well-known/contrail` + `lexicons.url` and re-run `@atcute/lex-cli generate` for a separate consumer app). Use `pnpm contrail lexicons check` in CI to verify generated Lexicons stay in sync.

Next: [Configure and query](./03-configure-and-query.md).
