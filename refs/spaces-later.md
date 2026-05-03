# Spaces: things to revisit later

Deferred items from the spaces design review. Not blocking shipping; keep an
eye on these as usage grows or as the permissioned-data spec firms up. See
also [spaces-spec-mapping.md](./spaces-spec-mapping.md).

Items resolved by the six-phase refactor (credential flow, host/authority
split, enrollment, community as separate package, etc.) have been removed
from this list — see the spec-mapping doc for the post-refactor state.

## Hydrated members endpoint

`space.listMembers` today returns raw `{did, addedAt, addedBy}` rows.
Every client ends up wanting profile hydration (handle, displayName, avatar).
Add `space.getMembers` (or extend `listMembers`) with:
- Cursor-based pagination (current endpoint is unbounded)
- Optional `hydrate=true` that joins against the configured profile collection
- Sort options (joined-at, alphabetical by handle)

## DID-doc publication helper

The authority's signing key needs to be published in its DID document under
`#atproto_space_authority` (verification method) — that's how external
verifiers find it. Today the deployer does this manually:
- For `did:web:contrail.example.com`: edit `.well-known/did.json`.
- For `did:plc`: a PLC operation signed with the rotation key.

A `contrail authority publish-key` CLI subcommand could:
- For `did:web`, emit the verification-method JSON to stdout for the deployer to drop into their DID doc.
- For `did:plc`, build and submit the PLC operation.

Without this, external verifiers can't validate the authority's credentials.
The in-process default works either way (host has the key directly).

## Auto-wiring discovery resolvers

`createPdsBindingResolver` and `createDidDocBindingResolver` are exported but
not wired into the default verifier. Today the in-process verifier uses only
`Local` (configured authority) + `Enrollment` (locally consented spaces).

For deployments that want to accept credentials from any authority that's
properly bound on a user's PDS or DID doc, the deployer composes the
resolvers manually (see [deployment-shapes](../docs/10-deployment-shapes.md)).

A higher-level config knob — `spaces.recordHost.acceptExternalAuthorities: true`
or similar — could auto-wire the full discovery chain. Decide whether the
fast-path (Local+Enrollment only) or the universal-path (full chain) is the
right default once we have real cross-host deployments.

## More tests

Phase 3-5 added good coverage for credentials, binding, enrollment. Gaps that
predate the refactor and still apply:

- Non-owner calling `createSpace` (should succeed — anyone can create their own).
- App policy enforcement in both `allow` and `deny` modes (clientId checks).
- `deleteRecord` by owner on another author's record (should fail).
- Re-querying a soft-deleted space returns NotFound.
- `leaveSpace` by owner (should error).
- `whoami` for owner, member, non-member, with and without community integration.

## Config-change behavior

What happens today if a deployment:

- Adds a new collection after spaces already contain data? The per-collection
  table (`spaces_records_<short>`) won't exist until schema init re-runs.
  `listCollections` swallows the missing-table error, but `putRecord` /
  `listRecords` will throw. Document and/or auto-create on demand.
- Toggles `allowInSpaces: false` on an existing collection? Table stays but
  routes stop dispatching. Orphaned data.
- Renames a collection's `collection` NSID? `shortNameForNsid` may change,
  so the derived table name changes — existing records become unreachable.

Need a config-drift audit (or migration) story.

## Verify `clientId` actually flows through

`checkAccess` uses `ServiceAuth.clientId` for app policy checks. Confirm:

- JWT verifier actually extracts `client_id` from real atproto service tokens
  (not just our test fixture).
- App policy with a populated `apps[]` blocks/allows correctly in practice.
- Empty `apps[]` under `mode: "deny"` blocks everyone (is that what we want?).

If `clientId` is `undefined` in the wild, app policy is decorative.

App policy is also currently checked at credential-issuance time but not
enforced again on the record host. For very long-lived credentials (>2h), an
app removed from the allowlist could continue acting until expiry. The TTL is
the spec's revocation bound; live with it.

## Join requests (spec-adjacent, not in spec)

The rough spec punts invite/onboarding mechanics to apps. A natural fit given
our invite system: a fourth kind `request` where `redeem` creates a pending
row for the owner to approve. Likely wants:

- `space.requestJoin` → creates pending row
- `space.listJoinRequests` (owner) → pending rows
- `space.approveJoinRequest` / `space.denyJoinRequest`

Should this live under `<ns>.space.*` or `<ns>.spaceExt.*`?

## Authority migration

A space's authority can change in principle — the `recordHost.enroll` row maps
`spaceUri → authorityDid`, re-enroll with a new authority and credentials
from the new authority will start verifying. But:

- Existing credentials from the old authority don't auto-revoke; they expire
  within their TTL.
- The PDS-record / DID-doc discovery sources (if used) need updating in lockstep.
- No helper API for this — the deployer or owner does each step manually.

A `<ns>.recordHost.transferAuthority` endpoint could automate the wire-level
parts (re-enroll, optionally short-circuit credential cache).

## Multi-authority spaces

In principle the architecture allows several authorities to all sign for one
space (replication / failover scenarios). The host's enrollment is 1:1 today
(one authority per space) but could become 1:N with a small schema change.
Spec is silent. Defer until a real use case.

## Ownership transfer

Dropped for now. The space URI is `ats://<ownerDid>/<type>/<key>` — owner DID
is baked into the URI, and every record/member/invite row keys off that URI
string. Transferring would mean either rewriting every referencing row in a
transaction (and breaking external refs to the old URI) or decoupling storage
from URI with an internal stable space id (bigger refactor). Revisit once the
spec pins down whether ownership transfer exists and what the URI authority
is supposed to be post-transfer.

## Real-time over credentials

Realtime tickets are signed by `realtime.ticketSecret`, not by the space
authority. If the host/authority split goes far enough that they're operated
by different parties, the realtime ticket model may need rethinking — does
the host mint tickets it then validates itself, or does the authority issue
realtime grants the host honors? Today both run in one process so it doesn't
matter.

---

## Resolved by the six-phase refactor (kept for history)

- ~~Space-credential flow~~ — done in phase 3.
- ~~Binding resolution (PDS records, DID-doc service entries)~~ — done in phase 4.
- ~~Independent host/authority deployments~~ — done in phase 5.
- ~~Real-time SSE / subscriptions~~ — landed via the realtime module.
- ~~Namespace split for contrail-specific extras~~ — `<ns>.spaceExt.*` shipped.
- ~~Community as separate package~~ — done in phase 6 (`@atmo-dev/contrail-community`).
