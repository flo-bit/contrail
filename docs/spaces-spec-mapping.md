# Spaces: mapping to the atproto permissioned-data rough spec

This is the map between contrail's spaces implementation and the rough spec
sketched at <https://dholms.leaflet.pub/3mhj6bcqats2o> (Daniel Holmgren,
March 2026). The spec is explicitly low-confidence and subject to change — so
is this doc. The goal is to make it obvious, when the real spec lands, where
contrail already lines up and where it needs to change.

Contrail is a backend-in-a-bottle / simple appview, not a PDS. For permissioned
data it currently stores everything in its own database; the plan is to
switch permissioned reads to come from users' PDSes once the protocol-level
flow is shipped (same story we already have for public records via jetstream).

---

## Concept-by-concept alignment

| Spec concept                   | Contrail                                                     | Alignment | Notes                                                                          |
| ------------------------------ | ------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------ |
| Space owner (DID)              | `spaces.owner_did`                                           | ✅        | 1:1                                                                            |
| Space type (NSID)              | `spaces.type`                                                | ✅        | 1:1                                                                            |
| Space key / skey               | `spaces.key`                                                 | ✅        | TID-generated when caller omits it                                             |
| Record addressing 6-tuple      | `(owner, type, key, author-did, collection, rkey)`           | ✅        | Storage is keyed by `(space_uri, did, rkey)`; `space_uri` encodes the first 3  |
| Single ACL = member list       | `spaces_members (did, perms)`                                | ✅        | Only `read`/`write` perms; owner is implicit write                             |
| Space credential (2–4h token)  | _none; service-auth JWTs used directly_                      | ❌        | Fine while contrail is a single appview. Add a shim when real PDS sync lands   |
| App allow/deny                 | `appPolicy {mode, apps[]}`                                   | ✅        | Matches spec's default-allow / default-deny model. Visible only to the owner   |
| Permissioned repo per user     | single DB (`spaces_records_<short>`)                         | ⚠️        | Structurally compatible — keyed per `(space, author)`. Federation is future    |
| ECMH commit / sync log         | _none_                                                       | ❌        | Out of scope until federated sync exists                                       |
| Pull-based sync, write notifs  | _none_                                                       | ❌        | Same                                                                           |
| URI scheme                     | `at://<owner>/<type>/<key>` for spaces; records not exposed  | ⚠️        | Spec floats `ats://`. We centralize construction in `src/core/spaces/uri.ts`   |
| Authority model for record URI | sidestepped (records keyed, not URI-addressed)               | ✅        | Spec is undecided; we don't commit either way                                  |
| Managing app routing           | _none (join-requests etc. not modeled yet)_                  | ⚠️        | See [spaces-later.md](./spaces-later.md)                                       |

---

## Endpoints

All endpoints are emitted under `<config.namespace>.space.*` from templates in
`spaces-lexicon-templates/`.

### Read
- `space.listSpaces` — caller's spaces (scope=member|owner)
- `space.getSpace` — metadata; supports `?inviteToken=` bearer read
- `space.listMembers` — members for a space (member/owner only)
- `space.listRecords` — space-scoped record listing; bearer-read supported
- `space.getRecord` — single record; bearer-read supported
- `space.whoami` — caller's relationship to a space (extra; not in spec)

### Write
- `space.putRecord`
- `space.deleteRecord`

### Owner-gated (space management)
- `space.createSpace`
- `space.addMember`
- `space.removeMember`
- `space.leaveSpace` — self-remove; owner must transfer first (extra)
- `space.transferOwnership` — new owner must already be a write member (extra)

### Invites (extra; not in the spec)
- `space.invite.create` — returns raw token once; hash stored
- `space.invite.redeem`
- `space.invite.list`
- `space.invite.revoke`

Invites have three kinds: `join`, `read`, `read-join`. `read` tokens grant
bearer-only anonymous read access; `read-join` does both; `join` requires a
signed-in caller and grants a membership row. None of this is in the spec —
it lives here because the spec explicitly defers invite/onboarding mechanics
to apps, and shipping a working invite primitive is useful for every consumer.

### Collection integration
Per-collection `listRecords` / `getRecord` accept `?spaceUri=` (space-scoped)
and optional `?inviteToken=`. Without `spaceUri`, authenticated callers get
public + own-member-spaces union (see `src/core/router/collection.ts`).

---

## Migration readiness

Hasn't shipped yet → nothing to migrate, but the shape of what changes when
the real spec lands:

1. **URI scheme swap (if any).** Centralized in `src/core/spaces/uri.ts` —
   flip `at://` to `ats://` (or whatever) in two helpers and every caller
   follows.
2. **Space-credential flow.** Needs an endpoint that mints short-lived tokens
   from an owner key, and a verifier that accepts them in place of a
   service-auth JWT on read paths. The current JWT middleware
   (`src/core/spaces/auth.ts`) is the right anchor for this.
3. **Read records from PDSes.** Mirrors the jetstream ingestion we already do
   for public data: consume permissioned-repo sync, write into the same
   `spaces_records_<short>` tables. The storage schema is already keyed per
   `(space, author)` so no migration needed on that side.
4. **ECMH commits & sync log.** Greenfield; unrelated to existing storage.
5. **Endpoint naming.** Spec doesn't pin XRPC names. When it does, rename
   lexicon template files + routes. No storage churn.

### Design decisions worth preserving
- Keep the member list as the single ACL. Don't add roles or per-collection
  policies just because it's easy — the spec is emphatic that the member list
  is _the_ ACL.
- Keep `space.whoami`, `space.leaveSpace`, `space.transferOwnership`, and the
  invite endpoints clearly labeled as contrail extras in docs. If the spec
  ends up naming some of them, renaming is cheap; relying on them from the
  base spec isn't.
- Don't mint a canonical record URI. The spec is undecided on the authority
  (user DID vs space owner DID); storing records by tuple avoids picking.

