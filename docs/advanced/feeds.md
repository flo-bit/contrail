# Feeds

Per-actor timelines of records authored by accounts that actor follows.

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

Contrail adds `app.bsky.graph.follow` automatically with `discover: false`. Set `follow` on the feed only if you use a different follow collection.

## Query

```ts
const res = await contrail.get("com.example.getFeed", {
  params: {
    feed: "network",
    actor: signedInDid, // whose feed (DID or handle), not record author
    collection: "community.lexicon.calendar.event",
    profiles: true,
    limit: 20,
  },
});
```

Filters, sorting, pagination, and hydration work like `listRecords` for the target collection.

## Notes

- The first read for an actor triggers a bounded follow backfill, so the very first response may be partial.
- New records fan out on ingest and prune down to each target's `maxItems`.
- Fan-out cost scales with an author's indexed follower count — suited for bounded app communities, not a network-wide Bluesky timeline.
