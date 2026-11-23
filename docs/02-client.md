# Add the typed client

Once your [local AppView](./01-getting-started.md) is configured, install Contrail and Atcute in your app and run `connect`:

```bash
pnpm add @atmo-dev/contrail @atcute/client @atcute/lexicons
pnpx @atmo-dev/contrail connect ../my-appview
```

`connect` accepts either a local directory containing `contrail.config.ts` or a deployed AppView's HTTPS URL. It installs the Lexicons, generates Atcute types, and writes a typed client module in `src/contrail/`.

## Query records

```ts
import { createLocalContrailClient } from "./contrail/index.js";

const contrail = createLocalContrailClient();
const res = await contrail.get("com.example.calendar.event.listRecords", {
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

When connecting to a deployed HTTPS AppView, use `createContrailClient()` instead of `createLocalContrailClient()`.

## Notify after writes

If your AppView enables `notify: true` (or `notify` with service auth), call `notifyOfUpdate` after writing a record to a user's PDS so it indexes immediately without waiting for Jetstream:

```ts
await contrail.post("com.example.calendar.notifyOfUpdate", {
  input: { uri: createdRecordUri },
});
```

## Updating

Re-run `connect` whenever the AppView config changes:

```bash
pnpx @atmo-dev/contrail connect ../my-appview
# or against a deployed URL:
pnpx @atmo-dev/contrail connect https://my-appview.example.com --update
```

Next: [Configure and query](./03-configure-and-query.md).
