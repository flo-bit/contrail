# @atmo-dev/contrail-lexicons

## 0.4.5

### Patch Changes

- Include `app.bsky.graph.follow` in the generated `lex.config.js` pull list when a feed leaves `FeedConfig.follow` unset. Mirrors the runtime default that `resolveConfig` auto-adds, so `lex-cli pull` fetches the schema instead of skipping it.

## 0.4.4

### Patch Changes

- 1a6d8cf: Handle the new `FeedConfig.targets` shape (`string | { collection, maxItems? }`) when generating the feed lexicon and computing pull NSIDs, and fall back to the default `"follow"` short name when `FeedConfig.follow` is unset.
- Updated dependencies [1a6d8cf]
  - @atmo-dev/contrail@0.5.0

## 0.4.3

### Patch Changes

- 9cca8cb: fix: resolve `feeds[*].follow` short names to NSIDs when emitting `lex.config.js`. previously the generator pushed the raw short name (e.g. `"follow"`) into `pull.sources[0].nsids`, causing `lex-cli pull` to fail with `ValitaError: must be valid nsid`. now matches the existing `collections` / `profiles` resolution path; feeds pointing at unknown collections are skipped instead of leaking `undefined`.

## 0.4.2

### Patch Changes

- Updated dependencies [8513b3e]
  - @atmo-dev/contrail@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [0e6ba77]
  - @atmo-dev/contrail@0.4.1

## 0.4.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [469bf65]
- Updated dependencies [469bf65]
  - @atmo-dev/contrail@0.4.0

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

- b81038c: add `contrail-lex publish` subcommand. wraps `publishLexicons` so you can push lexicon JSON to a PDS without writing a script:

  ```bash
  contrail-lex publish <handle> <app-password>
  # or via env:
  LEXICON_ACCOUNT_IDENTIFIER=you.bsky.social LEXICON_ACCOUNT_PASSWORD=xxxx contrail-lex publish
  ```

  supports `--generated-dir` (default `lexicons-generated`), `--skip-confirm` (for CI), and `--dry-run` (print what would be published + the DNS records needed, no writes, credentials not required).

### Patch Changes

- f8fa672: the lexicon generator previously auto-detected queryable fields by walking the pulled record schema (string → equality, datetime → range, etc.) and merged them with the user's explicit `queryable` before emitting `listRecords.json`.

  problem: the runtime does **not** auto-detect — it only honors fields explicitly declared in `colConfig.queryable`. So the generated lexicon advertised filter params (e.g. `?mode=online`, `?status=going`) that the server silently ignored. Clients would pass them and get unfiltered results back.

  fix: the generator now only emits what the user declared. the lexicon matches the runtime. one source of truth.

  if you were relying on the phantom params, add the fields explicitly to your config's `queryable` map. if you weren't, nothing changes except smaller, more honest `listRecords.json` files on the next `contrail-lex generate` run.

- b81038c: fix `contrail-lex --config <path.ts>` with plain TS files. previously broke with `ERR_UNKNOWN_FILE_EXTENSION` under plain node — bare `contrail-lex` invocation couldn't load TS configs. now uses `jiti` to handle TS + ESM + CJS transparently, so invocations like `contrail-lex all --config src/config.ts` work without needing tsx/ts-node preregistered.
- Updated dependencies [f8fa672]
- Updated dependencies [b81038c]
- Updated dependencies [ad3a61d]
- Updated dependencies [ad3063a]
- Updated dependencies [b81038c]
- Updated dependencies [3ee5ed4]
  - @atmo-dev/contrail@0.3.0

## 0.2.0

### Minor Changes

- 97bd494: split packages, monorepo
