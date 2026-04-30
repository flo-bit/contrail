# Feeds

Personalized "what the people I follow are doing" timelines, fanned out at write time. Opt-in; no cost if you don't enable it.

## Mental model

> A feed is a (follow-collection, [target-collections]) pair, named by you. Every time someone an *actor* follows posts to a target collection, contrail inserts one row into `feed_items` for that actor.

Reading a feed is a join through `feed_items` plus the standard pipeline (filters, sorts, hydration, references). The actor parameter on a read is *whose feed* you want — there is no anonymous feed read.

## Enable

```ts
import type { ContrailConfig } from "@atmo-dev/contrail";

const config: ContrailConfig = {
  namespace: "com.example",
  collections: {
    follow: { collection: "app.bsky.graph.follow" },
    post:   { collection: "app.bsky.feed.post", queryable: { /* ... */ } },
  },
  feeds: {
    timeline: {
      follow: "follow",            // short name (key in `collections`), NOT the NSID
      targets: ["post"],
      maxItems: 500,               // optional, default 200
    },
  },
};
```

Both the follow collection and every target collection must be declared in `collections`. Names in `feeds` are the **short names** (the keys of `collections`), not NSIDs. Config validation throws if you reference an unknown short name.

## Follow-record shape

The follow collection's record must have a `subject` field at the top level whose value is the followed DID. `app.bsky.graph.follow` matches this naturally:

```json
{ "subject": "did:plc:abc...", "createdAt": "2026-01-01T00:00:00Z" }
```

Custom follow lexicons work as long as `subject` is the followed DID at JSON path `$.subject`. Contrail extracts via that path during ingest fan-out and during follow-event backfill.

## Schema

Two tables, one shared across all feeds:

| Table | Purpose |
|---|---|
| `feed_items (actor, uri, collection, time_us)` | One row per (viewer, target record). Primary key `(actor, uri)` so a single target record can appear in many feeds. |
| `feed_backfills (actor, feed, completed)` | Marker so first-read backfill only runs once per (actor, feed). |

Indexes: `(actor, collection, time_us DESC)` and `(actor, time_us DESC)` on `feed_items`, plus a JSON `subject` index on each follow collection's records table for the fan-out join.

## Read

```
GET /xrpc/{namespace}.getFeed?feed=timeline&actor=<did-or-handle>&limit=50
```

| Param | Meaning |
|---|---|
| `feed` | Feed name from `config.feeds` (required) |
| `actor` | Whose feed — DID or handle (required) |
| `collection` | Restrict to one target collection's short name (default: first in `targets`) |
| `limit`, `cursor`, filters from the target's `queryable`, hydration flags, sort/order | Same as `listRecords` on the target collection |

The `actor` parameter is **whose feed** you're reading, not a filter on record creator. Feeds are always per-user.

```ts
const feed = await fetch(
  `/xrpc/com.example.getFeed?feed=timeline&actor=${did}&limit=50&profiles=true`
).then((r) => r.json());
// feed.records — target records by users `actor` follows, newest first
// feed.profiles — hydrated profile records for record authors
```

## How fan-out works

Three moments:

1. **A target write.** Someone followed by N actors posts to a target collection. Contrail inserts N `feed_items` rows in one statement (`INSERT … SELECT … FROM <followTable> WHERE subject = ?`). Cost is linear in N — there is no max-followers cap; a viral author with 1M followers is 1M inserts.

2. **A follow write.** An actor follows a new user. Contrail backfills the most recent **100** target records from that user into the new follower's feed. The 100 is hardcoded in `core/router/feed.ts` — separate from the per-feed `maxItems` cap, and not tunable per feed today.

3. **First read for an (actor, feed) pair.** Contrail backfills the actor's follow records from their PDS (so their `feed_items` rows can be computed), then populates `feed_items` from existing target records by users they already follow. Marked complete in `feed_backfills` so it runs once per pair.

## Pruning

The persistent worker (or cron run) trims `feed_items` per actor down to the largest configured `maxItems` across feeds, keeping newest by `time_us`. There is no per-feed prune — one global cap.

## Deletes

Deleting a target record removes its `feed_items` rows across all actors. Deleting a follow record currently does not retroactively prune the feed_items inserted during the original follow backfill — they age out via the global pruner instead.

## XRPCs

- `{namespace}.getFeed` — read

That's it. Feeds are read-only over XRPC; writes to follow / target collections happen through `com.atproto.repo.putRecord` on the user's PDS as normal, and Jetstream ingestion drives the fan-out.

## What's not here

- No per-feed prune cap; the global pruner uses the largest `maxItems` across all feeds.
- The 100-record backfill on a new follow is hardcoded — not tunable per feed.
- No dedicated test coverage for feeds yet (the production paths work, but treat the integration as load-bearing-but-untested).
- No max-followers cap on target writes — a target record by a user with 1M followers means 1M `feed_items` inserts. For apps expecting that scale, partition feeds or rate-limit upstream.
- Feeds live in the **main DB** even when [spaces](./06-spaces.md) are split onto a separate DB; there is no `feeds_db` binding.
- Feeds do not currently union with [spaces](./06-spaces.md) records — `getFeed` reads only public target records.
