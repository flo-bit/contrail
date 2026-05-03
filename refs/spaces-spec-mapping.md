# Spaces: mapping to the atproto permissioned-data rough spec

This is the map between contrail's spaces implementation and the rough spec
sketched at [dholms.leaflet.pub/3mhj6bcqats2o](https://dholms.leaflet.pub/3mhj6bcqats2o) (Daniel Holmgren,
March 2026). The spec is explicitly low-confidence and subject to change — so
is this doc. The goal is to make it obvious, when the real spec lands, where
contrail already lines up and where it needs to change.

Contrail is a backend-in-a-bottle / simple appview, not a PDS. For permissioned
data it currently stores everything in its own database; the long-term plan
is to switch permissioned reads to come from users' PDSes once the
protocol-level flow is shipped (same story we already have for public records
via jetstream).

The spaces implementation went through a six-phase refactor (phases 1–6,
documented in conversation history) that aligned the architecture with the
spec and split community out into its own package. This doc reflects the
post-refactor state.

---

## Concept-by-concept alignment

| Spec concept                   | Contrail                                                        | Alignment | Notes                                                                                                       |
| ------------------------------ | --------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| Space owner (DID)              | `spaces.owner_did`                                              | ✅        | 1:1                                                                                                         |
| Space type (NSID)              | `spaces.type`                                                   | ✅        | 1:1                                                                                                         |
| Space key / skey               | `spaces.key`                                                    | ✅        | TID-generated when caller omits it                                                                          |
| Record addressing 6-tuple      | `(owner, type, key, author-did, collection, rkey)`              | ✅        | Storage is keyed by `(space_uri, did, rkey)`; `space_uri` encodes the first 3                               |
| `ats://` URI scheme            | `ats://<owner>/<type>/<key>`                                    | ✅        | Centralized in `src/core/spaces/uri.ts`                                                                     |
| Single ACL = member list       | `spaces_members (did)`                                          | ✅        | Membership is binary. Owner is implicit member. No read/write tiering.                                      |
| Member list `(did, read\|write)` tuples | binary membership only                                  | ⚠️        | Spec says read/write tiered. Pragmatic divergence; flip if/when spec firms                                  |
| Member list as PDS record      | server-side state on authority                                  | ⚠️        | Spec says published on owner's PDS, synced. Future migration; the authority caches today                    |
| Space credential (2–4h token)  | ES256 JWTs via `<ns>.space.getCredential` / `refreshCredential` | ✅        | Phase 3. Default 2h TTL. `iss` = authority DID; signed with the authority's published key                   |
| Credential signed by owner key | signed by **issuer** DID; binding from PDS record / DID-doc / owner-self | ⚠️ ext | Spec says owner-key. We extend so user-owned DIDs can authorize a separate issuer without DID-doc surgery   |
| App allow/deny                 | `appPolicy {mode, apps[]}`                                      | ✅        | Matches default-allow / default-deny. Checked at credential issuance only                                   |
| Discovery via DID doc          | `#atproto_space_authority` service entry resolver               | ✅        | Phase 4. Plus PDS-record fallback (extension) and owner-self fallback                                       |
| Permissioned repo per user     | single DB (`spaces_records_<short>`)                            | ⚠️        | Structurally compatible — keyed per `(space, author)`. Federation is future                                 |
| ECMH commit / sync log         | _none_                                                          | ❌        | Out of scope until federated sync exists                                                                    |
| Pull-based sync, write notifs  | _none_                                                          | ❌        | Same                                                                                                        |
| Authority model for record URI | sidestepped (records keyed, not URI-addressed)                  | ✅        | Spec is undecided; we don't commit either way                                                               |
| Managing app routing           | _none (join-requests etc. not modeled yet)_                     | ⚠️        | See [spaces-later.md](./spaces-later.md)                                                                    |
| Host/AppView split             | `spaces.authority` + `spaces.recordHost` independently runnable | ➕        | Phase 5. Spec implies but doesn't fully model. See [deployment-shapes](../docs/10-deployment-shapes.md)     |
| Enrollment as host consent     | `<ns>.recordHost.enroll` + `record_host_enrollments` table      | ➕        | Phase 5. Spec doesn't address consent — we add explicit binding registration                                |

Legend: ✅ aligned · ⚠️ pragmatic divergence · ❌ unimplemented (deliberate) · ➕ extension over the spec

---

## Endpoints

All endpoints are emitted under `<config.namespace>.*` from templates in
`packages/lexicons/lexicon-templates/`.

### Authority (`<ns>.space.*` — spec-aligned)
- `createSpace` `getSpace` `listSpaces` `deleteSpace`
- `listMembers` `addMember` `removeMember` `leaveSpace`
- `getCredential` `refreshCredential`

### Record host
- `<ns>.space.putRecord` `deleteRecord` `getRecord` `listRecords`
- `<ns>.space.uploadBlob` `getBlob` `listBlobs` (optional)
- `<ns>.recordHost.enroll`

### Contrail extras (`<ns>.spaceExt.*`)
Clearly-off-spec features that don't map cleanly to the rough spec.
- `whoami` — caller's relationship to a space (owner / member / extension fields)

### Invites (`<ns>.invite.*`)
- `create` `redeem` `revoke` `list`

Invites have three kinds: `join`, `read`, `read-join`. Spec defers
invite/onboarding mechanics to apps; we ship a working primitive because
every consumer needs one.

### Collection integration
Per-collection `listRecords` / `getRecord` accept `?spaceUri=` (space-scoped)
and optional `?inviteToken=`. Without `spaceUri`, authenticated callers get
public + own-member-spaces union (see `src/core/router/collection.ts`).

---

## What changed in the six-phase refactor

| Phase | Brought us | Notes |
|---|---|---|
| 1 | `SpaceAuthority` + `RecordHost` interface boundary | Pure refactor; `StorageAdapter` is their union |
| 2 | Spaces no longer imports community | Whoami extension hook + `CommunityInviteHandler` interface |
| 3 | Credential issuance + verification | ES256 JWTs, `X-Space-Credential` header, in-process verifier |
| 4 | Binding resolution | PDS-record + DID-doc resolvers; `iss != owner` allowed via the binding |
| 5 | Independent deployment + enrollment | Authority and host runnable as separate processes; `recordHost.enroll` consent |
| 6 | Community as separate package | `@atmo-dev/contrail-community` with integration interface |

After phase 6 the architecture maps to the spec roughly as:

```
                   spec concept                contrail mapping
                   ────────────                ────────────────
              "space host"                ─→   space authority (signs creds, holds members)
              "permissioned repo"         ─→   record host (stores records, enrolls spaces)
              "external space hosts"      ─→   binding resolver chain (multi-authority support)
              "managing app routing"      ─→   not yet (deferred — spaces-later.md)
```

---

## Migration readiness

What still needs to change when the real spec lands:

1. **Member list moves to PDS records.** The spec says it's a record on the owner's PDS, synced. Our authority holds it server-side. Future: a watcher consumes member-list records via Jetstream and reconciles into `spaces_members`. Auth-side `addMember` becomes a PDS write rather than an internal API.

2. **Records federate from user PDSes.** Today the record host *is* the source of truth. When permissioned-repos ship, records federate; the host becomes an aggregator. Storage schema (`spaces_records_<short>`, keyed per `(space, author)`) already supports this — the change is in the write path, not the read path.

3. **ECMH commits & sync log.** Greenfield. Required for federation.

4. **Endpoint naming.** Spec doesn't pin XRPC names. When it does, rename lexicon template files + routes. No storage churn.

5. **Possibly: `(did, read|write)` member tuples.** If the spec stays at tiered membership and doesn't move to binary, add an `access` column on `spaces_members` and branch the ACL check in `acl.ts`. One-day change.

6. **Possibly: credential `iss = owner DID`.** If the spec forbids the issuer-DID indirection we use for user-owned DIDs, fall back to "owner adds a host-controlled verification method to their DID doc" (HappyView's hidden assumption). Operationally heavier; we hold the looser reading until forced to tighten.

---

## Design decisions worth preserving

- **Keep the member list as the single ACL.** Don't add roles or per-collection policies just because it's easy — the spec is emphatic that the member list is _the_ ACL.
- **Membership is binary, not tiered.** Previously had `perms: "read" | "write"` per member row; collapsed to plain membership because the rough spec is moving toward "member = access, apps filter writes." Delete keeps the owner / own-record rule, but that's about *which records you can affect*, not a permission tier on the member row.
- **Don't over-engineer the space row with pre-emptive extension columns.** Previously had `member_list_ref` as a hook for externally-managed membership; dropped because the community-module case is handled via ownership (community-owned spaces are managed by the community module, no flag column needed). If a future need for external membership sources shows up, add the column then.
- **Keep `spaceExt.whoami`, `space.leaveSpace`, and the invite endpoints clearly labeled as contrail extras in docs.** If the spec ends up naming some of them, renaming is cheap; relying on them from the base spec isn't.
- **Don't mint a canonical record URI.** The spec is undecided on the authority (user DID vs space owner DID); storing records by tuple avoids picking.
- **Enrollment is the host's source of truth.** Even when PDS records and DID-doc service entries declare authority bindings, the host's local enrollment is what actually gates record acceptance. Keeps the host's consent explicit and prevents abuse of the open-ended discovery layer.
- **Keep the issuer-DID indirection as an extension, not a hard architectural choice.** The credential verifier supports `iss == owner` (literal-spec) and `iss != owner` (with binding). If the spec forbids the latter, we degrade gracefully.
