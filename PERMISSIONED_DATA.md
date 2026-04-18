# Permissioned Data

Contrail ships an opt-in permissioned-spaces subsystem: a write-capable, auth-gated XRPC store for records that can't live on public PDSes. It's designed to be used today and to migrate cleanly to Bluesky's real [permissioned spaces](https://dholms.leaflet.pub/3mhj6bcqats2o) when those ship.

## Why this exists

Real atproto permissioned repos don't exist yet. Apps that need private data (invite-only events, team forums, group messaging) either go fully public and gate at the app layer (insecure), or roll their own server (locks data out of atproto entirely).

Contrail's spaces feature is the middle path: a **centralized, auth-gated store** with the same primitives Bluesky proposed — spaces, member lists, app policies, service-auth tokens — so the data model, XRPC surface, and consent UX match what the protocol will eventually standardize. On migration day, you move data from our hosted DB into user PDSes; the API your app talks to doesn't change.

**Tradeoff:** data lives in *your* database, not on user PDSes. Fine for interim use when you (or the space owner) run the service. Not a long-term replacement for real permissioned repos.

## Mental model

> A **space** is a bag of records with one lock. The **member list** says who has the key.

- Each space has one owner (DID), one type (classifying NSID), one key (string). Identified by an at-uri: `at://<owner>/<type>/<key>`.
- A space holds records of *any* NSID. Same role a PDS repo plays, scoped to a shared context.
- Each member has a **perms** value: `"read"` or `"write"`. The space owner is implicit `write`.
- Each space has an optional **app policy**: `{ mode: "allow" | "deny", apps: [client_id, …] }` — gates which OAuth clients can act in the space.

That's it. Every feature (private channels, invite-only threads, shared albums) is one-space-per-permission-boundary with records of whatever NSIDs the app defines. If you need finer-grained access (e.g. "admins" vs "members"), model it as multiple spaces or enforce at the app layer.

## Design choices worth naming

**Each permission boundary = its own space.** No nested ACLs, no per-record permissions, no per-collection policies. Matches the blog's model; keeps the library generic.

**Read/write as the only permission axis.** The library enforces: read = any member, write = members with `"write"` (owner always). Apps that need richer roles layer them on top of multiple spaces or check `clientId` / authorDid in their handlers.

**atproto service-auth JWTs.** Verification uses `@atcute/xrpc-server/auth.ServiceJwtVerifier`: validates signature against issuer's DID doc, checks `aud` matches the configured service DID, checks `lxm` covers the method. Same path third-party apps and our own code go through.

**Per-deployment namespace, not shared transport lexicons.** A deployment owning `com.example` emits `com.example.space.*` XRPCs and a `com.example.permissionSet` — OAuth consent screens show your domain, not a third party's. Client generation pulls lexicons from your repo.

**Per-collection spaces tables with full parity.** Each collection you declare gets both `records_<short>` (public) and `spaces_records_<short>` (private), with the same count columns and indexes. Filters, sorts, hydration, and references all work in either mode.

**Unified `listRecords`.** The per-collection endpoint accepts three call shapes:

| Call | Returns |
| --- | --- |
| No auth, no `spaceUri` | Public records only |
| `?spaceUri=…` + service-auth JWT | Records from that one space (ACL-gated) |
| Service-auth JWT, no `spaceUri` | Public records **unioned** with records from every space the caller is a member of |

The union path runs the public and per-space queries in parallel and merges with a shared keyset cursor, so filters, sorts, hydration, and references all work across sources. Records from a space carry a `space: <spaceUri>` field in the response.

**Opaque keyset cursors.** `base64url(JSON({ t, v?, k }))` — tiebreaker `time_us`, sort-key value, and sort-kind tag. Cursors with a `k` that doesn't match the current sort are silently ignored (instead of returning wrong results). This lets one cursor be shared across every sub-query in the union.

**Invites are stored tokens.** Random 32-byte token returned once on creation; SHA-256 hash is persisted. Redemption is a single atomic UPDATE that increments `used_count` only if `!revoked && !expired && !exhausted`.

**Two-DB split is opt-in.** `initSchema(db, config, { spacesDb })` and `createApp(db, config, { spacesDb })`. Spaces tables can live on a separate binding for different backup/compliance constraints; defaults to the main DB.

**Everything is opt-in.** No `config.spaces` set = zero extra tables, zero extra routes, zero new deps activated.

## Architecture

```
src/core/spaces/
  types.ts      — SpacesConfig, StorageAdapter, row types
  schema.ts     — DDL for spaces / spaces_members / spaces_invites base + per-collection tables
  adapter.ts    — HostedAdapter: CRUD + space-scoped count maintenance on putRecord/deleteRecord
  acl.ts        — pure checkAccess(): owner / member-read / member-write / app-policy logic
  auth.ts       — buildVerifier + verifyServiceAuthRequest
  router.ts     — Hono route registration for <ns>.space.*
  invite-token.ts, tid.ts — crypto helpers
```

Auth flow (per request):

1. **`<ns>.space.*` routes**: service-auth middleware validates the JWT (signature, `aud`, `lxm`) and populates `c.var.serviceAuth = { issuer, audience, lxm, clientId }`. Handler fetches space + caller's membership via the adapter, runs `checkAccess`, dispatches to the adapter on allow, returns 403 with a structured `reason` on deny.
2. **Per-collection `listRecords`/`getRecord` with `?spaceUri=…`**: same verify + ACL gate, then dispatches to the adapter (scoped to the one space).
3. **Per-collection `listRecords` with auth but no `spaceUri`**: verify, list caller's member spaces via `adapter.listSpaces({ memberDid })`, run the public + per-space union.

## Usage

```ts
import type { ContrailConfig } from "@atmo-dev/contrail";

const config: ContrailConfig = {
  namespace: "myapp",
  collections: {
    event:    { collection: "community.lexicon.calendar.event", /* ... */ },
    location: { collection: "myapp.event.location" },
    message:  { collection: "myapp.event.message" },
  },
  spaces: {
    type: "myapp.event.space",       // classifying NSID for this kind of space
    serviceDid: "did:web:myapp.com", // plain DID, no fragment — see note below
    // resolver: optional — defaults to composite did:plc + did:web
    // defaultAppPolicy: optional — app-level deny/allow list
  },
};
```

Per-collection opt-out:

```ts
collections: {
  public_only: { collection: "myapp.public", allowInSpaces: false },
}
```

Client-side (from another app consuming a space service):

```ts
const response = await userPdsClient.post("myapp.space.putRecord", {
  headers: { "Atproto-Proxy": "did:web:myapp.com#myapp_space" },
  input: { spaceUri, collection: "myapp.event.message", record: { text: "hi" } },
});
```

The user's PDS validates OAuth scope against `myapp.permissionSet` (auto-generated), mints a service-auth JWT with `aud=did:web:myapp.com`, forwards to your service, which verifies and executes.

> **Note on service DIDs.** Use the plain DID (no service fragment) as `serviceDid`. Many PDS implementations reject `aud` values with `#fragment` in `com.atproto.server.getServiceAuth`, and the middleware does strict string equality on `aud`. The fragment form (`did:web:myapp.com#myapp_space`) only belongs in your DID doc's service entry, where PDSes use it to resolve the service endpoint URL for `Atproto-Proxy` routing — that's a separate concern from JWT audience validation.

## DNS requirements

Permission sets live under your namespace (`myapp.permissionSet`), which means PDSes need to resolve that NSID via DNS. atproto NSID resolution does **not** walk up subdomains — each emitted lexicon needs its own `TXT` record at `_lexicon.<reversed-domain-path>`. The publish script (`scripts/publish-lexicons.ts`) prints the exact records you need. You must control the domain.

## What's deliberately not in here

- **No E2EE.** Data is operator-readable. Appropriate for "invite-only" not "journalists-under-threat."
- **No per-space sharding/replication.** One DB, one operator.
- **No lexicon validation on write.** Add at the app layer if you need it.
- **No moderation/report primitives.** App layer.
- **No FTS in space mode (yet).** Search on `?spaceUri=…` is skipped. A composite-keyed `fts_spaces_<short>` would fix this — flagged as follow-up because the same at-URI can appear in multiple spaces.
- **No hybrid single-record split.** A record is either on a public PDS (contrail-indexed) or inside a space. The unified `listRecords` stitches both sides back together at read time.

## Migrating to real permissioned spaces

Design choices made so migration is mostly data movement, not API redesign:

- **TID rkeys from day one** — already valid atproto rkeys.
- **JSON payloads stored as they'd appear on a PDS** — no shape translation at migration time.
- **Per-member `authorDid` column** — each member can write their slice into their own permissioned repo via `applyWrites`.
- **`exportSpace` API planned** — will dump all records in the shape the PDS will accept. Migration day: loop over members, call export + applyWrites, flip a flag. Keep old DB read-only as fallback.
- **OAuth permission set follows the spec format** — one `permission` entry with `{ resource: "rpc", inheritAud: true, lxm: […] }`, so the same user consent works whether the target is your interim service DID or (eventually) a real permissioned-repo PDS.

## Status

Interim by design. If Bluesky ships real permissioned repos and you own the service, plan to migrate. If they don't, this shape is stable: we designed the transport and consent UX to match the protocol proposal, so the API your apps speak doesn't change on migration day.
