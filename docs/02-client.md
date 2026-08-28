# Add the typed client

With your [local AppView](./00-getting-started.md) set up, add Contrail and Atcute to your application:

```bash
pnpm add @atmo-dev/contrail @atcute/client @atcute/lexicons
pnpx @atmo-dev/contrail connect ../my-appview
```

Point `connect` at the directory containing `contrail.config.ts`. It resolves the source and query Lexicons, then uses Atcute to generate a typed client in `src/contrail/`.

Use it from your app:

```ts
import { createLocalContrailClient } from "./contrail/index.js";

const contrail = createLocalContrailClient();
const response = await contrail.get("com.example.event.listRecords", {
  params: {
    startsAtMin: new Date().toISOString(),
    limit: 20,
  },
});

if (!response.ok) throw new Error(`Contrail returned ${response.status}`);

for (const event of response.data.records) {
  console.log(event.value.name, event.value.startsAt);
}
```

The method name, parameters, and response are all typed from the Lexicons. Re-run `connect` when the AppView config changes.

Next: [configure filters, sorting, and hydration](./03-configure-and-query.md). To use an existing deployed AppView, pass its HTTPS URL to `contrail connect` instead of a config path.
