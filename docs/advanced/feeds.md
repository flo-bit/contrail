# Feeds

Feeds provide a per-user timeline of records authored by people that user follows.

## Configure

```ts
export default {
  namespace: "com.example",
  collections: {
    event: { collection: "community.lexicon.calendar.event" },
  },
  feeds: {
    network: {
      targets: [{ collection: "event", maxItems: 200 }],
    },
  },
};
```

The default follow collection is `app.bsky.graph.follow`. Contrail adds it internally with `discover: false`; declare a different collection and set `follow` only when your app uses another follow record type.

## Query

```ts
const response = await contrail.get("com.example.getFeed", {
  params: {
    feed: "network",
    actor: signedInDid,
    collection: "community.lexicon.calendar.event",
    profiles: true,
    limit: 20,
  },
});
```

`actor` means “whose feed,” not “record author.” It accepts a DID or handle. Filters, sorting, pagination, and hydration work like `listRecords` for the selected target collection.

The first read starts a bounded backfill of that actor's follows, so its initial result may be partial. New target records are then fanned out during normal ingestion. Old items are pruned to each target's `maxItems` cap.

Fan-out cost grows with an author's number of indexed followers. Feeds are therefore a projection for bounded application communities, not a replacement for a network-wide timeline service.
