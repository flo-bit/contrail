# @atmo-dev/contrail-sync

## 0.12.2

## 0.12.1

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.1

## 0.9.0

## 0.8.0

## 0.7.0

### Minor Changes

- 7e3145b: Spaces refactor: split authority + record host into independently runnable
  roles, add space credentials, extract community into its own package.

  **Breaking — config shape**

  `spaces` is no longer flat — split into `authority` and `recordHost`:

  ```ts
  // before
  spaces: {
    type: "com.example.event.space",
    serviceDid: "did:web:example.com",
    blobs: { adapter, maxSize },
  }

  // after
  spaces: {
    authority: {
      type: "com.example.event.space",
      serviceDid: "did:web:example.com",
      signing: await generateAuthoritySigningKey(),
    },
    recordHost: {
      blobs: { adapter, maxSize },
    },
  }
  ```

  **Breaking — community moved to its own package**

  Community has been extracted to `@atmo-dev/contrail-community`. Wire it via
  `createCommunityIntegration`:

  ```ts
  import { Contrail, resolveConfig } from "@atmo-dev/contrail";
  import { createCommunityIntegration } from "@atmo-dev/contrail-community";

  const resolved = resolveConfig(config);
  const communityIntegration = createCommunityIntegration({
    db,
    config: resolved,
  });
  const contrail = new Contrail({ ...config, communityIntegration });
  ```

  The community config (`config.community`) stays the same; only the wiring
  moves. Imports of `CommunityAdapter`, `registerCommunityRoutes`,
  `reconcile`, etc. now come from `@atmo-dev/contrail-community` instead of
  `@atmo-dev/contrail`.

  **New — space credentials (`X-Space-Credential`)**

  The space authority issues short-lived ES256 JWTs (default 2h TTL) via
  `<ns>.space.getCredential` and `refreshCredential`. The record host accepts
  them on read/write paths in lieu of per-request service-auth JWTs. Skips
  DID-doc fetches and member checks; the credential's signature is the proof.

  Generate a signing key once at deploy time:

  ```ts
  import { generateAuthoritySigningKey } from "@atmo-dev/contrail";
  const signing = await generateAuthoritySigningKey();
  // Store the JWK; pass to spaces.authority.signing.
  ```

  **New — binding resolution**

  Verifiers can resolve "which authority signs for this space?" from three
  sources, in order: local enrollment table, PDS records at
  `at://<owner>/<type>/<key>`, DID-doc `#atproto_space_authority` service
  entry, owner-self fallback. Lets user-owned DIDs authorize a third-party
  authority via a normal PDS write — no DID-doc surgery.

  **New — independent deployments + enrollment**

  The authority and record host can run as separate processes/operators.
  A new `<ns>.recordHost.enroll` endpoint lets owners (or authorities)
  register a space onto a host. In-process deployments auto-enroll on
  `createSpace`; nothing changes for single-instance setups.

  See `docs/10-deployment-shapes.md` for all-in-one / authority-only /
  host-only configurations and when to choose each.

  **Migration**

  For most deployments running spaces today, the migration is:

  1. Update the config: split `spaces.{type, serviceDid, blobs}` into
     `spaces.authority.{type, serviceDid}` and `spaces.recordHost.{blobs}`.
  2. Generate and store an authority signing key
     (`generateAuthoritySigningKey()`); add to `spaces.authority.signing`.
  3. If using community: install `@atmo-dev/contrail-community`, build
     `createCommunityIntegration({ db, config })`, pass via
     `new Contrail({ communityIntegration })` (or `createApp({ community })`).

  Existing service-auth JWT clients keep working as a fallback path.
  Migrate to space credentials when convenient — exchange a JWT for a
  credential once via `getCredential`, then reuse it.

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

## 0.2.0

### Minor Changes

- 97bd494: split packages, monorepo
