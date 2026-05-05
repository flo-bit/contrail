---
"@atmo-dev/contrail": minor
---

Add per-collection `recordFilter` and apply Jetstream `#identity` handle changes during ingest.

- `CollectionConfig.recordFilter?: (record) => boolean` runs against each create/update during ingest; returning false drops the record before it reaches the DB. Useful for narrowing high-volume collections to just the records you care about (e.g. only `app.bsky.feed.post` records mentioning a particular URL). Deletes are not filtered, so they still tear down any record the filter previously let through. Throws are caught, logged, and treated as drops.
- Jetstream `#identity` events (handle changes) now flow through to the `identities` table via a new `applyIdentityEvent` helper. UPDATE-only — unknown DIDs are no-ops so we don't materialize partial rows lacking PDS.
