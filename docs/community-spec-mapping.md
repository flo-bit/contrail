# Communities: mapping to the Arbiter design post

This is the map between contrail's community module and the Arbiter design
sketched at <https://zicklag.leaflet.pub/3mjrvb5pul224> (zicklag / Roomy,
April 2026). The post is an early design note and will likely evolve — so
will this doc. The goal is to make it obvious, when the standard firms up,
where contrail already lines up and where it needs to change.

Contrail's community module layers community-owned spaces and tiered
access-level management on top of the [spaces](./spaces-spec-mapping.md)
module. Ownership alone — spaces owned by a community DID — is the signal
that a space is community-managed. All the Arbiter's "group management"
complexity lives here; the spaces module stays close to the rough
permissioned-data spec with no knowledge of access levels or delegation.

---

## Concept-by-concept alignment

| Arbiter concept                             | Contrail                                                            | Alignment | Notes                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| Community as a DID                          | `communities.did`                                                   | ✅        | 1:1                                                                                                      |
| Mint a fresh did:plc for a community        | `community.mint` → P-256 keypairs + genesis op + plc.directory POST | ✅        | Post uses secp256k1; we use P-256 (both spec-valid, we avoid the dep)                                    |
| Adopt an existing account                   | `community.adopt` (app password)                                    | ➕        | Not in the post; contrail addition. See [community.md](./community.md) for the rationale                  |
| Creator-held rotation key (recovery)        | Returned once by `community.mint` as `recoveryKey`                  | ✅        | Never stored; caller must save it                                                                        |
| Groups-are-spaces                           | Community-owned rows in `spaces`                                    | ✅        | No separate groups table; every group is a space                                                         |
| `$admin` reserved space                     | Auto-created on community creation                                  | ✅        | Keyed by the literal string `$admin`; cannot be deleted                                                  |
| `$publishers` reserved space                | Auto-created on community creation                                  | ➕        | Not in the post; contrail extension for the "publish public records as the community" capability         |
| Delegated membership (space → space)        | `community_access_levels.subject_kind = 'space'`                    | ✅        | Recursive resolution with cycle guard + depth cap                                                        |
| Access-level ladder                         | `member` / `manager` / `admin` / `owner`                            | ⚠️        | 4 levels vs the post's 8. See [community.md § Relationship to the Arbiter post](./community.md)           |
| Read-Member-List (pre-member tier)          | _none_                                                              | ❌        | Post's level 1; skipped in v1                                                                            |
| Add-Members vs Remove-Members split         | Bundled into `manager`                                              | ⚠️        | Post treats them separately                                                                              |
| Configure-Space                             | `admin` in that space                                               | ✅        | Post's level 5                                                                                           |
| Create-Spaces in `$admin`                   | `admin` in `$admin`                                                 | ✅        | Post's level 6                                                                                           |
| Remove-Space                                | `owner` in target space OR `admin` in `$admin`                      | ✅        | Post's level 7                                                                                           |
| Owner                                       | `owner`; only meaningful in `$admin` for owner-management           | ✅        | Post's level 8                                                                                           |
| Push model for membership lists             | Reconciler writes `spaces_members` after each change                | ➕        | Post doesn't specify a sync direction; push keeps spaces read-path zero-overhead                         |
| Cross-community / cross-arbiter delegation  | _same-contrail only_                                                | ❌        | v1 constraint. Private-membership federation is deferred — see [community.md § Deferred work]            |
| Invites as a separate service               | `community.invite.*` (create/list/revoke/redeem)                    | ➕        | Built-in — tokens pre-sign a grant, redeemer gets the encoded access level. SHA-256 at rest, atomic redeem. |
| Writing records under the arbiter's account | `community.space.putRecord` (in-space) + `community.putRecord` (public) | ✅    | In-space: `admin+`. Public: `member+` in `$publishers` — routes through adopted community's PDS          |
| Public membership-list flag                 | _none_                                                              | ❌        | Post allows spaces to expose membership publicly. Ruled out for cross-instance federation (privacy)      |
| Space credential (from arbiter)             | _none_                                                              | ⚠️        | Covered by the spaces module's service-auth story, not the community module                              |

Legend: ✅ aligned · ⚠️ partial / different granularity · ❌ missing · ➕ contrail extension (not in the post)

---

## XRPC surface

All endpoints emitted under `<config.namespace>.community.*` from templates
in `community-lexicon-templates/`. Distinct from `<ns>.space.*` so the
user-managed spaces surface stays clean. Community-managed spaces live
under `<ns>.community.space.*` so the endpoint name reveals whether
membership is user-controlled or community-controlled.

### Community lifecycle
- `community.adopt` · `community.mint` · `community.reauth` · `community.delete`
- `community.list` · `community.getHealth` · `community.whoami`

### Space (group / role / channel) lifecycle
- `community.space.create` · `community.space.delete`

### Membership
- `community.space.grant` · `community.space.revoke` · `community.space.setAccessLevel`
- `community.space.listMembers` (`?flatten=true` for the resolved DID list) · `community.space.resync`

### Invites
- `community.invite.create` · `community.invite.list` · `community.invite.revoke` · `community.invite.redeem`

### Publishing
- `community.putRecord` · `community.deleteRecord` (public records via the community's PDS; adopted only)
- `community.space.putRecord` · `community.space.deleteRecord` (in-space records authored by the community DID)

---

## Contrail extensions over the post

Labelled ➕ in the alignment table, worth calling out explicitly so
future renames against a standard are easy:

- **`adopt` mode** for communities backed by a regular ATProto account.
  App passwords are the default because they don't have the periodic
  re-auth ceremony OAuth does, which matters for machine-operated
  community accounts.
- **`$publishers` reserved space.** The post doesn't model "publish public
  records as the community" — we gate that capability via a second
  reserved space so it's orthogonal to `$admin` governance without
  widening the access ladder.
- **Push-based reconciliation into `spaces_members`.** The post doesn't
  specify sync direction; push keeps the spaces read path O(1) and lets
  the spaces module stay oblivious to delegation.

---

## Migration readiness

Hasn't shipped as a standard yet. When it does, likely churn areas:

1. **Level renames / additions.** Our 4 are a coalesce of the post's 8.
   If a standard lands with finer tiers, add rows to the enum and
   migrate existing values — `community_access_levels.access_level` is
   a plain text column.
2. **Cross-instance delegation.** Our v1 is local-only. When private
   cross-contrail federation is figured out (encrypted membership
   records, authenticated pull, something else), the `subject_space_uri`
   field already supports remote URIs structurally — only the
   resolution path needs to change.
3. **Invites.** When the post's invite service firms up, reuse the
   spaces invite primitive or fork it. Adding an invite service as a
   member of `$admin` with `manager` access is the model; no schema
   change anticipated.
4. **Publishing for minted communities.** Currently returns
   `NotSupported`. When contrail-as-PDS or PDS-less minted publishing
   is defined, drop the check.

---

## Design decisions worth preserving

- **Spaces doesn't know the community module exists.** Dependency is
  one-way: community writes to spaces tables; the spaces module never
  imports from `src/core/community/`. Preserve this — it's what keeps
  the spaces surface close to the permissioned-data spec.
- **Ownership is the signal.** Community-owned = owner DID is in
  `communities`. No flag columns on `spaces`. Preserve this — adding a
  delegation flag re-introduces a schema hook we deliberately dropped.
- **Access levels govern arbiter operations only.** Never leak them
  into record-level ACLs or app-level role systems. App roles belong
  as records, not as levels.
- **Orthogonal capabilities go in reserved `$`-spaces, not new
  ladder rungs.** `$publishers` is the first; `$moderators`,
  `$billing`, etc. can follow. This keeps the ladder small and
  extensions additive.
- **Push, not pull, for `spaces_members`.** Read-path overhead has to
  stay zero; complexity belongs in the writer.
- **Single-instance is a feature, not a gap.** Federation is the
  hard problem; defer cleanly with a local-only assertion at grant
  time until private-distribution shape is clear.
