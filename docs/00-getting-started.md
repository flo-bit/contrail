# Get started locally

Run a local AppView for a public AT Protocol collection with Node.js 22.13 or newer.

Create an empty directory with one file:

```ts
// contrail.config.ts
export default {
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { startsAt: { type: "range" } },
    },
  },
};
```

Then run:

```bash
pnpx @atmo-dev/contrail dev
```

Contrail resolves the Lexicons, backfills existing records, follows new records, and serves a resumable SQLite AppView at `http://127.0.0.1:8787`.

```bash
curl 'http://127.0.0.1:8787/xrpc/com.example.event.listRecords?limit=10'
```

Replace the collection and fields with your own. Next: [add the typed client to your app](./01-client.md).
