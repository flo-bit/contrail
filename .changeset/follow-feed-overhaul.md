---
"@atmo-dev/contrail": minor
---

Follow-feed overhaul. Several related changes that together fix correctness and storage problems with how follow-driven feeds are bootstrapped, ingested, and recovered.

**Backfill correctness — `time_us` now reflects record `createdAt`.** Backfilled records previously had `time_us` set to ingest time, which silently broke any time-ordered query and made `feed_items` snapshots taken right after a backfill useless. The canonical time is parsed from the record's `createdAt` (clamped to now to defuse user-supplied future timestamps) and used as `time_us`. Per-collection override via the new `CollectionConfig.timeField` (set to `false` to keep ingest time, e.g. for collections without a time field).

**`feed_backfills.completed` no longer falsely marks success.** The wrapper used to mark `completed = 1` even when the underlying follow walk timed out or returned zero, locking users into a permanently empty feed. The flag now flips only after `backfills.completed = 1` is observed for the follow collection. New `retries`, `last_error`, and `started_at` columns mirror the existing `backfills` schema and let stuck rows be re-armed after `BACKFILL_STALE_MS`.

**Feed bootstrap moved out of the request path.** `getFeed` no longer blocks on a synchronous PDS walk. Instead it claims the `feed_backfills` row and schedules `runFeedBackfill` via `c.executionCtx.waitUntil` (Cloudflare Workers) or fire-and-forget on Node/Bun. First request returns whatever `feed_items` already has; subsequent requests reflect the full backfill once it lands. Live fanout (which adds a new follow's last 100 posts on the spot) makes the empty first response uncommon in practice for already-active users.

**Per-target item caps.** `FeedConfig.targets` now accepts `string | { collection, maxItems? }`, and pruning partitions by `(actor, collection)` so a high-volume target (e.g. RSVPs) can't squeeze a low-volume one (e.g. events) out of the cap. `pruneFeedItems` accepts either a global cap (legacy) or `Map<collection-NSID, cap>`; jetstream/persistent ingest cycles now compute the per-collection map via `buildFeedTargetCaps`.

**Subject filter for follow ingest + backfill.** New `CollectionConfig.subjectField` — when set, ingest drops records whose subject DID isn't already in `identities`. For a typical bsky user with 2k follows but only 10 pointing at known DIDs, this trims storage by ~200x. Applied identically in live jetstream filtering and per-page during backfill.

**`app.bsky.*` defaults to `discover: false`.** Any collection whose NSID lives under `app.bsky.*` and doesn't explicitly set `discover` is treated as dependent — preventing a footgun where forgetting `discover: false` on `app.bsky.graph.follow` would persist every follow on the network.

**Auto-add follow collection.** `FeedConfig.follow` is now optional and defaults to `"follow"` (auto-added with NSID `app.bsky.graph.follow`, `discover: false`, and `subjectField: "subject"`) when no feed declares it. `feeds: { home: { targets: ["post"] } }` now produces correct behavior with no explicit follow plumbing.

**Constellation reverse-lookup (opt-out, default on).** When a DID first appears in `identities` via a discoverable event, contrail queries [Constellation](https://constellation.microcosm.blue/) for follow records pointing at that DID and ingests synthesized rows for any follower already in `identities`. Lets newcomers immediately surface in existing users' feeds without per-follower PDS walks. Disable with `constellation: false` or `constellation: { enabled: false }`. Sends `User-Agent: contrail/<namespace>` per Constellation's request that callers identify themselves.

**Wire-level `collection` param accepts NSIDs.** `getFeed` now matches the generated lexicon enum: the `collection` parameter is interpreted as a full NSID and translated to the short name internally. Short names are still tolerated for backwards compatibility.
