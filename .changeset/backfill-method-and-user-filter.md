---
"@atmo-dev/contrail": minor
---

Add `backfillMethod` config (`"listRecords" | "car"`) and `userFilter` for excluding users from indexing.

- `backfillMethod` chooses how a user's history is fetched. Default `"listRecords"` keeps the existing per-(user, collection) paginated walk. Opt into `"car"` for one streamed `com.atproto.sync.getRepo` per user covering every configured collection — dramatically faster on multi-collection configs but pulls the whole repo regardless of which collections you index.
- `userFilter?: ({ did, handle, pds }) => boolean` runs after identity resolution. Returning true marks the user excluded: `identities.excluded` flips to `1` (new column with auto-migration), pending `backfills` rows are dropped, future PDS lookups short-circuit, and jetstream drops their commits and identity events. Filter checks fire on first PDS resolution, stale-identity refresh, and `#identity` events. Use for handle-suffix exclusions, deny-lists, etc.
