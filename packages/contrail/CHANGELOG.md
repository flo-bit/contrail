# @atmo-dev/contrail

## 0.4.0

### Minor Changes

- 469bf65: unify the per-space marker field on records as `space` everywhere. previously `listRecords` / `getRecord` HTTP responses used `space: <spaceUri>` while watch events and `WatchRecord` exposed it as `_space`. the underscored form was inconsistent with the surrounding fields (`uri`, `cid`, `did`, etc.) and forced consumers to remember which path produced which name.

  **breaking.** anywhere you read `r._space` on a `WatchRecord` (or a watch event payload's `record._space` / `child._space`), rename to `r.space`. drop-in.

  ```ts
  // before
  if (record._space) ...

  // after
  if (record.space) ...
  ```

  no migration needed for `listRecords` / `getRecord` consumers — that path was already `space`.

- 469bf65: permissioned spaces now use the `ats://` scheme instead of `at://`. tracks the [permissioned data spec](https://dholms.leaflet.pub/3mhj6bcqats2o), which floats `ats://` as a distinct scheme so spaces can't be confused with atproto record URIs at any layer (logs, query params, dispatch, error messages).

  ```
  - at://did:plc:alice/com.example.event.space/birthday
  + ats://did:plc:alice/com.example.event.space/birthday
  ```

  what changed:

  - `buildSpaceUri` / `parseSpaceUri` (`@atmo-dev/contrail`) emit / accept `ats://`. anything else returns `null` from `parseSpaceUri`.
  - generated lexicons no longer claim `format: "at-uri"` on `spaceUri` params, on the `space` record-output field, or on `spaceView.uri` — they're plain `string`. (atproto's `at-uri` format would reject `ats://`.) regenerate committed `lexicons/generated/*` with `contrail-lex generate`; downstream `lex-cli generate` then emits `v.string()` instead of `v.resourceUriString()` for those fields.
  - realtime topics are unchanged in shape (`space:<uri>`), but `<uri>` is now an `ats://` URI.
  - record URIs (the `uri` on a record, the `appPolicyRef` field, `notifyOfUpdate` payloads) keep `at://` — those are still atproto record URIs.

  **breaking.** anywhere you build a space URI by string concatenation (`` `at://${did}/${type}/${key}` ``), switch to `ats://` or call `buildSpaceUri()`. anywhere you persist space URIs in your own DB, migrate (`UPDATE … SET space_uri = REPLACE(space_uri, 'at://', 'ats://') WHERE space_uri LIKE 'at://%'`).

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

- b81038c: rename `contrail.sync()` → `contrail.backfillAll()` and emit progress via `config.logger` by default.

  the method previously returned `{ discovered, backfilled }` but emitted no output, so callers had to wire up their own `onProgress`. it now logs discovery + throttled backfill progress + final summary through `config.logger` (defaults to `console`). supplying `onProgress` still takes over, and passing a no-op logger silences it.

  also renames the internal `backfillAll` function (in `src/core/backfill.ts`) to `backfillPending` to reduce confusion with the new public method. not publicly exported, so no user-facing impact.

  adds a `contrail` CLI bin with a `backfill` subcommand so workers deploys don't need a local script file at all:

  ```json
  "scripts": {
    "backfill":        "contrail backfill --config src/config.ts",
    "backfill:remote": "contrail backfill --config src/config.ts --remote"
  }
  ```

  auto-detects `contrail.config.ts`, `app/config.ts`, or `src/lib/contrail/config.ts`; loads TS configs via `jiti` (no tsx hook required). flags: `--config`, `--remote`, `--binding <name>`, `--concurrency <n>`.

  the underlying helper is also exported at `@atmo-dev/contrail/workers` for embedded use:

  ```ts
  import { backfillAll } from "@atmo-dev/contrail/workers";
  await backfillAll({ config, remote: true });
  ```

  `wrangler` is an optional peer dep — only imported at runtime when the cli/helper is called.

  breaking: `contrail.sync()` is gone; rename callsites to `contrail.backfillAll()`. signature and return shape unchanged.

- ad3a61d: add `contrail dev` — local dev wrapper for cloudflare workers deployments.

  replaces `wrangler dev --test-scheduled` + a separate cron-trigger script with one command. on start it:

  1. connects to your local D1 via wrangler's `getPlatformProxy`, inspects state
  2. prompts to run `backfillAll` if no completed backfills exist yet
  3. prompts to run `refresh` if the ingest cursor is older than 60 minutes (configurable with `--stale-after`)
  4. spawns `wrangler dev --test-scheduled`
  5. fires `GET /__scheduled?cron=...` every 60 seconds so the cron actually runs in local dev (wrangler's scheduler only works in deployed production)

  flags: `--cron <expr>` (default `"*/1 * * * *"`), `--stale-after <min>` (default 60), `--yes` to auto-accept prompts, plus the standard `--config` / `--root` / `--binding`.

  prompts are skipped in non-TTY environments (default-declined).

  also adds `--yes` to the CLI-wide arg parser.

- ad3063a: two new DX pieces:

  **`@atmo-dev/contrail/worker`** exports `createWorker(config, options?)` — a prebuilt Cloudflare Workers entry that collapses the ~12-line `{ fetch, scheduled }` boilerplate to one line:

  ```ts
  import { createWorker } from "@atmo-dev/contrail/worker";
  import { config } from "./contrail.config";
  import { lexicons } from "../lexicons/generated";

  export default createWorker(config, { lexicons });
  ```

  options: `binding` (D1 binding name, default `"DB"`), `lexicons` (see below), `onInit` (one-shot app-specific setup).

  **`/xrpc/<ns>.lexicons` endpoint + `contrail-lex pull-service`** lets consumer apps typegen against a deployed contrail over HTTP, no PDS or DNS required:

  - `contrail-lex generate` now emits a barrel `lexicons/generated/index.ts` that imports every lexicon the deployment speaks: generated + pulled + custom. The pulled lexicons are needed so consumer typegen can resolve `$ref`s out of the generated schemas.
  - Pass `{ lexicons }` to `createWorker` (or `createHandler(contrail, { lexicons })`) and the service exposes them at `GET /xrpc/<namespace>.lexicons`.
  - From a consumer app:
    ```bash
    contrail-lex pull-service https://my-contrail.dev/xrpc/com.example.lexicons
    # or
    contrail-lex pull-service https://my-contrail.dev --namespace com.example
    ```
    Fetches the manifest, writes each lexicon under `lexicons/pulled/`. Then `npx lex-cli generate` emits TS types.

  Path 1 of 4 of a set of DX improvements — path 2 (consumer typegen) works end-to-end but assumes the operator has regenerated. Paths 3 (one-command deploy) and 4 (fully vendored worker) are deferred.

- b81038c: add `refresh` — a "catch-up" CLI + method that reconciles every known DID's PDS against the DB and reports what was missed.

  unlike `backfillAll`, it ignores the `backfills` state table and sweeps fresh. useful after jetstream outages or after leaving a dev deployment idle for days.

  each record in each configured collection is classified as:

  - **missing** — PDS has it, DB doesn't
  - **stale update** — DB has it with a different CID, _and_ the DB row was written before the ignore window (default 60s, configurable)
  - **in sync** — same CID, or DB row is within the ignore window

  ```bash
  pnpm contrail refresh                   # totals
  pnpm contrail refresh --by-collection   # + per-nsid breakdown
  pnpm contrail refresh --ignore-window 30
  ```

  programmatic: `contrail.refresh({ ignoreWindowMs, concurrency })` returns per-collection stats + totals. also exported from `@atmo-dev/contrail/workers` as `refresh()` for wrangler-backed deployments.

  safe to run repeatedly — each pass converges toward zero. not a replacement for `ingest` / `runPersistent` (walks every user's history, which is expensive); use for after-outage reconciliation or dev-idle catch-up.

  also extends `ExistingRecordInfo` with an `indexed_at: number | null` field so callers using `lookupExistingRecords` can inspect per-row freshness without a second query.

### Patch Changes

- 3ee5ed4: tighten spaces ACL: owners no longer bypass the "own-record" rule on delete. everyone in the member list — owner included — can only delete records they authored.

  before: owner calling `space.deleteRecord` on someone else's record returned `200 { ok: true }` (ACL passed, but the adapter's SQL was already scoped to `did = caller`, so no rows were actually deleted — the response lied).

  after: that same call returns `403 { error: "Forbidden", reason: "not-own-record" }`. honest response; no behavior change at the storage layer.

  to wipe someone else's records in a space you own, delete the space itself.

## 0.2.0

### Minor Changes

- 97bd494: split packages, monorepo

## 0.1.1

### Patch Changes

- ef42ef2: remove transfer ownership

## 0.1.0

### Minor Changes

- 247d1fc: add permissioned data stuff, change endpoints, add lexicon publishing

## 0.0.8

### Patch Changes

- e2a5e77: update profiles

## 0.0.7

### Patch Changes

- 409223a: make notify endpoint safer, more fixes

## 0.0.6

### Patch Changes

- c6f82da: add postgres adapter and example

## 0.0.5

### Patch Changes

- 4c8153b: testing trusted publishing
