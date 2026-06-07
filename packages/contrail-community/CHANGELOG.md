# @atmo-dev/contrail-community

## 0.11.0

### Patch Changes

- @atmo-dev/contrail@0.11.0
- @atmo-dev/contrail-base@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [89aee1b]
  - @atmo-dev/contrail-base@0.10.0
  - @atmo-dev/contrail@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [4c8fedb]
  - @atmo-dev/contrail-base@0.9.1
  - @atmo-dev/contrail@0.9.1

## 0.9.0

### Patch Changes

- @atmo-dev/contrail@0.9.0
- @atmo-dev/contrail-base@0.9.0

## 0.8.0

### Minor Changes

- bea0dd2: A third community-creation mode: **provision**. alongside the existing `adopt` (caller already has a `did:plc`) and `mint` (caller wants a DID but brings their own PDS) modes, contrail can now provision a community on a stock `@atproto/pds` end-to-end — minting the `did:plc`, creating and activating the PDS account, generating an app password, and persisting credentials so the existing `community.putRecord` / `.deleteRecord` publish path keeps working. contrail never holds PDS admin credentials.

  **`xrpc/{ns}.community.provision`** runs the five-step PLC + PDS dance (key generation → PLC genesis → `createAccount` → `getRecommendedDidCredentials` + signed PLC update op → `activateAccount`), persists each step in a new `provision_attempts` table so a partially-failed attempt can be resumed, mints an app password, and seeds the session cache.

  **`contrail-community reap [--all-stuck] [--older-than <minutes>] [--db <url>] [--dry-run]`** new CLI (a bin shipped by `@atmo-dev/contrail-community`) that cleans up provision attempts which didn't reach `status='activated'` by tombstoning their PLC entries. `--dry-run` is the default; per-row confirmation is required for live reaping unless `--all-stuck` is given. `--all-stuck` only acts on rows idle at least `--older-than` minutes (default 30) so a bulk run can't tombstone an in-flight provision. Runs against the Cloudflare D1 binding by default, or against the decoupled Postgres index when `--db`/`DATABASE_URL` is set. It ships as a contrail-community bin because the PR #30 package split removed contrail's edge into community code: under pnpm's isolated `node_modules` the core `contrail` CLI can't resolve `@atmo-dev/contrail-community`, so `contrail reap` only registers in hoisted installs where both packages sit together.

  custody model: the caller supplies a `rotationKey` and that key sits at `rotationKeys[0]` — the highest-priority rotation slot on the resulting DID. contrail generates a subordinate keypair and persists it (AES-GCM-encrypted under `masterKey`) at `rotationKeys[1]`, so it can submit later PLC ops on the community's behalf — most importantly the post-activation PLC update during provision, and the tombstone op that `reap` issues to clean up stuck DIDs.

  the caller's key dominates: PLC's 72-hour nullification window means any op contrail signs with its subordinate key can be overridden within 72h by an op signed with the caller's key. with this caveat: a tombstone is irrevocable. a malicious or compromised contrail instance could tombstone any DID it provisioned. there is no managed code path, no shared rotation, and `rootCredentials` are returned to the caller in the response so they can also be persisted out-of-band.

  what you need to configure / know:

  - new `community` config block: `masterKey` (32-byte AES-GCM envelope key for the encrypted credential columns), `allowedProvisionPdsEndpoints` (URL-origin matching, collapses scheme case / default ports / trailing slash / IDN), optional `plcDirectory` override.

  - **provisioning fails closed.** When `allowProvisioning` is true, `allowedProvisionPdsEndpoints` MUST be non-empty — a missing/empty allowlist no longer means "accept any PDS" (that was a fail-open hole: any caller could have a PLC genesis op signed by Contrail's rotation key against an attacker-chosen PDS). To deliberately accept any endpoint, set the separate, loud `allowAnyProvisionPdsEndpoint: true`. The field was renamed from `allowedPdsEndpoints` to make clear it gates _provisioning_ only, not which PDSes Contrail reads/indexes.

  - new tables `provision_attempts` and `community_credentials`. credentials are stored AES-GCM-encrypted under that key; lose the key, lose the ability to mint sessions for previously-provisioned communities.

- d7e0936: Private-network deployment support via a new optional `ContrailConfig.networkOverrides` block.

  `networkOverrides` carries three optional subfields, all defaulting to the current public-internet behavior (omit the block entirely and nothing changes):

  - **`resolver`** — a custom `DidDocumentResolver` used during DID-doc PDS fallback, labeler-endpoint resolution, and spaces service-auth JWT verification. Lets a deployment point at a private PLC mirror or inject a custom fetch (mTLS, retry, instrumentation). Trusted; not SSRF-checked.
  - **`slingshotUrl`** — override the slingshot identity-resolver endpoint. Trusted; not SSRF-checked.
  - **`additionalAllowedHosts`** — hostnames that bypass the default SSRF guard when validating a resolved PDS or labeler endpoint. Match is exact, case-insensitive, port-agnostic (e.g. `["pds.dev.svc.cluster.local"]`). This is the only knob that widens the validator; there is no "disable SSRF" flag.

  The overrides are threaded through PDS/identity resolution (`resolvePDS`, `getPDS`, `getClient`, `resolveIdentity*`, `refreshStaleIdentities`), labeler endpoint resolution and ingest (`resolveLabelerEndpoint`, `getLabelerState`, label subscribe cycles), and service-auth verification (`buildVerifier` in both the appview router and the community integration). The in-scope `config` is now also passed at every appview call site that resolves identities or PDS endpoints — the live-ingest refresh cycle (`runIngestCycle` → `refreshStaleIdentities`), the on-demand `refresh` path, and the router actor/identity/PDS resolution paths (`getProfile`, `getFeed`, collection queries, profile hydration, notify) — so private-network deploys honor the override on those paths instead of silently falling back to the public resolver and un-widened SSRF guard.

  The SSRF guard is now a single shared validator: `validateExternalUrl(url, additionalAllowedHosts?)` is exported from `contrail-base` and consumed by both the PDS client and labeler-endpoint resolution. `validateEndpointUrl` remains exported as a thin alias for backward compatibility. This removes the previous duplicate validator (`validatePdsUrl` + `validateEndpointUrl`) where an allowlist or SSRF-rule edit could be applied to only one copy.

  Also hardens schema initialization for concurrent/Postgres deployments: a dialect-aware `addColumnIfNotExists` (Postgres `ADD COLUMN IF NOT EXISTS`; SQLite pre-check), narrow absorption of the Postgres concurrent-`CREATE` race (42P07 / 23505 on pg_type/pg_class/pg_namespace indexes), and per-statement (rather than batched) DDL during `initSchema` / `initSpacesSchema` / spaces schema. Genuine DDL errors (syntax, type mismatch, missing column/table) still propagate.

### Patch Changes

- Updated dependencies [bea0dd2]
- Updated dependencies [d7e0936]
  - @atmo-dev/contrail@0.8.0
  - @atmo-dev/contrail-base@0.8.0

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

### Patch Changes

- Updated dependencies [7e3145b]
  - @atmo-dev/contrail@0.7.0
  - @atmo-dev/contrail-base@0.7.0
