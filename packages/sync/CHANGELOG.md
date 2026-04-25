# @atmo-dev/contrail-sync

## 0.3.0

### Minor Changes

- f8fa672: align the `listRecords` / `getRecord` response envelope with atproto's `com.atproto.repo.*`. the field that carries the record value is now `value`, not `record`.

  **before** (contrail-specific):

  ```jsonc
  { "records": [{ "uri", "did", "collection", "rkey", "cid", "record": {...}, "time_us" }] }
  ```

  **after** (atproto-compatible plus extras):

  ```jsonc
  { "records": [{ "uri", "cid", "value": {...}, "did", "collection", "rkey", "time_us" }] }
  ```

  changes:

  - `#record` def now requires `["uri", "cid", "value"]` (matches atproto's standard `com.atproto.repo.listRecords#record`). `did`/`collection`/`rkey`/`time_us` remain in the response but are optional.
  - `getRecord` top-level output requires `["uri", "value"]` (matches atproto's `com.atproto.repo.getRecord`).
  - profile entries in `?profiles=true` responses use `value` instead of `record` for the profile record body.
  - realtime watch events (`record.created`, `snapshot.record`, `hydration.added`) — the inner record payload's body field is now `value`.
  - `@atmo-dev/contrail-sync`: `WatchRecord.value` (was `record`); `addOptimistic({ value })` (was `record`).

  **breaking.** anywhere you read `r.record` from a contrail response, rename to `r.value`. anywhere you call `addOptimistic({ record: ... })`, switch to `addOptimistic({ value: ... })`. regenerate committed `lexicons/generated/*` in each deployment — the new shape will be advertised on next `contrail-lex generate` run.

## 0.2.0

### Minor Changes

- 97bd494: split packages, monorepo
