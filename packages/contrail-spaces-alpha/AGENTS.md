# Spaces extension

- Pin the complete published Spaces tuple; current target is `0.0.0-spaces-alpha-20261029171913`. Keep alpha-only pnpm overrides scoped to those prerelease ranges.
- This is an unused pre-release extension with no existing persisted data. Target the current pinned protocol directly; do not add legacy adapters or upgrade migrations.
- PDSes own policies, membership and records. This package is an AppView plus trusted app-side helpers, not an authority, repo host or OAuth token store.
- Public and isolated projections must not share tables, version state, diagnostics, FTS, counts, references or cache keys. Private schema validation must not change public validation.
- Sync policy validation reads only the authority's published `com.atproto.space.policy/self`, with record MAC/URI/CID verification. Require `publishPolicy`; getSpace is owner-OAuth-only. Use one explicit policy and never silently change policy types or discard members.
- Managing apps serve `com.atproto.managedspace.checkUserAccess` with matching lxm for both reads and writes. Re-register notifications when the authority PDS changes. SpaceNotFound is ambiguous authorization loss, never deletion.
- Every private read requires exact-Space authorization. An aggregate sync credential is not a user's read grant. Read leases never authorize writing.
- MAC-bearing requests need a fresh KEM key share per request/page/retry. Verify MAC, requested repo/Space, record CIDs and complete LtHash state before projection/checkpoint changes. Never replay revoked credentials.
- Full recovery stages writer generations; failed recovery cannot replace visible data. A missing listing entry or failed renewal does not prove deletion. Purge on authenticated deletion/SpaceDeleted; recreation requires explicit rediscovery.
- Invitation records are stored in a separate owner-only personalspace control Space and contain only secret verifiers. Preview must not create membership, expose credentials/references/guest lists, or consume the invite. Acceptance uses the authenticated guest DID and a restored app-owned owner session.
- Keep native membership separate from RSVP and link revocation. These APIs are in-process trusted operations, not browser-authorized endpoints. Apps must supply CSRF/rate limits and cross-isolate session coordination.
- Run core regressions and built tests, extension typecheck/tests/build, then `test:workerd` (local only). Do not deploy, publish records, or change real memberships as a test.
- RSVP routes/editor, distributed app-session storage and real-PDS evidence are not implemented here; do not describe this foundation as a shipped end-to-end RSVP feature.
