# Add the typed client

Generate the AppView's Lexicons and TypeScript types from your `contrail.config.ts`, then query with `@atmo-dev/contrail/client` (or `@atcute/client` directly):

```bash
pnpm add @atmo-dev/contrail @atcute/client @atcute/lexicons
pnpm contrail lexicons all
```

`contrail lexicons all` generates your AppView XRPC Lexicons into `lexicons/generated/`, pulls referenced source Lexicons, and runs Atcute type generation into `src/lexicon-types/`.

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

## Notify after writes

If your AppView enables `notify: true` (or `notify` with service auth), call `notifyOfUpdate` after writing a record to a user's PDS so it indexes immediately without waiting for Jetstream:

```ts
await contrail.post("com.example.notifyOfUpdate", {
  input: { uris: [createdRecordUri] },
});
```

## Updating

Re-run `pnpm contrail lexicons all` whenever `contrail.config.ts` changes, and use `pnpm contrail lexicons check` in CI to verify generated Lexicons stay in sync.

Next: [Configure and query](./03-configure-and-query.md).
