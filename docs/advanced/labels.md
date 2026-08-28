# Labels

Contrail can subscribe to AT Protocol labelers and attach their labels to records and profiles.

## Configure

```ts
export default {
  namespace: "com.example",
  collections: {
    event: { collection: "community.lexicon.calendar.event" },
  },
  labels: {
    sources: [
      { did: "did:plc:ar7c4by46qjdydhdevvrndac" },
    ],
  },
};
```

Normal `contrail backfill`, Worker cron ingestion, and `runPersistent()` include configured labelers automatically.

## Select labelers

A request chooses labelers with the standard header:

```text
Atproto-Accept-Labelers: did:plc:ar7c4by46qjdydhdevvrndac
```

Use `?labelers=did:plc:...` when setting a header is inconvenient. Without either, Contrail uses `labels.defaults`, or all configured sources when defaults are omitted. Set `defaults: []` to require callers to opt in.

Selected labels appear as `record.labels`. Account labels appear on hydrated profile entries. The response's `Atproto-Content-Labelers` header reports which configured labelers were applied.

Contrail drops expired labels, applies CID-pinned labels only to the matching record version, and treats newer `neg: true` labels as retractions.

Label signatures are stored but are not currently verified. Contrail consumes labels; it does not publish a label stream or provide moderation-preference UI.
