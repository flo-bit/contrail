# Spaces: things to revisit later

Deferred items from the spaces design review. Not blocking shipping; keep an
eye on these as usage grows or as the permissioned-data spec firms up. See
also [spaces-spec-mapping.md](./spaces-spec-mapping.md).

## Hydrated members endpoint
`space.listMembers` today returns raw `{did, perms, addedAt, addedBy}` rows.
Every client ends up wanting profile hydration (handle, displayName, avatar).
Add `space.getMembers` (or extend `listMembers`) with:
- Cursor-based pagination (current endpoint is unbounded)
- Optional `hydrate=true` that joins against the configured profile collection
- Sort options (joined-at, alphabetical by handle)

## More tests
The e2e + invite tests cover the happy paths. Gaps:
- Non-owner calling `createSpace` (should succeed — anyone can create their
  own) vs non-member trying to use someone else's space URI
- App policy enforcement in both `allow` and `deny` modes (clientId checks)
- `deleteRecord` by owner on another author's record
- Re-querying a soft-deleted space returns NotFound
- `leaveSpace` by owner (should error)
- `whoami` for owner, member, non-member

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
  (not just our test fixture)
- App policy with a populated `apps[]` blocks/allows correctly in practice
- Empty `apps[]` under `mode: "deny"` blocks everyone (is that what we want?)

If `clientId` is `undefined` in the wild, app policy is decorative.

## Join requests (spec-adjacent, not in spec)
The rough spec punts invite/onboarding mechanics to apps. A natural fit given
our invite system: a fourth kind `request` where `redeem` creates a pending
row for the owner to approve. Likely wants:
- `space.requestJoin` → creates pending row
- `space.listJoinRequests` (owner) → pending rows
- `space.approveJoinRequest` / `space.denyJoinRequest`

Should this live under `space.*` or a separate extras namespace?

## Real-time: SSE / subscriptions
Every collaborative app wants "new records in this space, as they land."
The spec's sync model uses write-notifications through the space owner; we
don't have that yet. Lightweight interim: Server-Sent Events on
`space.subscribeRecords?spaceUri=&collection=`. Works for first-party apps
right away; swap to the real thing later.

## Namespace split for contrail-specific extras — done
`space.invite.*` and `space.whoami` moved to `<ns>.spaceExt.*`. See
[spaces-spec-mapping.md § Contrail extras](./spaces-spec-mapping.md#contrail-extras-namespace-nsspaceext).
`leaveSpace` is still in `space.*` — revisit if the spec lands with different
self-remove semantics.

## Ownership transfer
Dropped for now. The space URI is `at://<ownerDid>/<type>/<key>` — owner DID
is baked into the URI, and every record/member/invite row keys off that URI
string. Transferring would mean either rewriting every referencing row in a
transaction (and breaking external refs to the old URI) or decoupling storage
from URI with an internal stable space id (bigger refactor). Revisit once the
spec pins down whether ownership transfer exists and what the URI authority
is supposed to be post-transfer.
