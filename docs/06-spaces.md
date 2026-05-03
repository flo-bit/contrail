# Spaces

Auth-gated store for records that can't live on public PDSes — private events, invite-only groups, members-only chat. Opt-in; zero cost if you don't enable it.

## Mental model

> A **space** is a bag of records with one lock. The **member list** says who has the key.

- One owner (DID), one type (NSID), one key. Identified by `ats://<owner>/<type>/<key>` — distinct scheme from atproto record URIs (`at://`) so the two can't be confused at any layer.
- Every member (including owner) has read + write inside the space. Delete is scoped to your own records — no one can remove records they didn't author, owner included. To wipe everything, delete the space.
- Optional **app policy** gates which OAuth clients can act in the space.

Every permission boundary is its own space. No nested ACLs. Richer roles = more spaces or app-layer checks.

### Two roles, one or two services

A space has two operational roles:

- **Space authority** — owns the member list, signs short-lived credentials. Identified by a service DID.
- **Record host** — stores records and blobs for spaces it has *enrolled*.

In the default deployment both run in the same Contrail instance against the same DB; you don't notice the split. But the roles can also run separately — see [deployment shapes](./10-deployment-shapes.md) for ACL-on-arbiter / records-on-contrail patterns.

## Enable

```ts
import type { ContrailConfig } from "@atmo-dev/contrail";
import { generateAuthoritySigningKey } from "@atmo-dev/contrail";

// One-time setup: generate a signing key and store it. The authority signs
// space credentials with this key; verifiers find the public key in the
// authority DID's DID document or via the binding-resolver chain.
const signing = await generateAuthoritySigningKey();

const config: ContrailConfig = {
  namespace: "com.example",
  collections: { /* ... */ },
  spaces: {
    authority: {
      type: "com.example.event.space",
      serviceDid: "did:web:example.com",
      signing,                          // omit to disable credential issuance
      credentialTtlMs: 2 * 60 * 60 * 1000, // 2h, matches the rough spec
    },
    recordHost: {
      // blobs is optional; omit to disable blob endpoints
      blobs: { adapter: blobsAdapter },
    },
  },
};
```

Each collection gets a parallel `spaces_records_<short>` table. Opt out per-collection:

```ts
public_only: { collection: "com.example.public", allowInSpaces: false }
```

## Auth — three paths

The record host accepts three forms of auth on read/write paths, in this precedence order:

1. **`X-Space-Credential` header** — a short-lived JWT minted by the space authority. The primary path: callers exchange a service-auth JWT once via `space.getCredential`, then present the credential on every request until it expires. Skips per-request DID-doc fetches and member checks; the credential's signature is the proof.
2. **`?inviteToken=...` query** (read-only) — bearer access for shareable links. See [Auth § Invite tokens](./05-auth.md#invite-tokens).
3. **`Authorization: Bearer <service-auth-jwt>`** — the standard atproto path. Useful for one-off calls (the credential exchange itself, space-management endpoints) or as a fallback when the caller doesn't want to manage credentials.

Authority-side endpoints (`createSpace`, `addMember`, `getCredential`, etc.) only accept service-auth JWTs — credentials are scoped to record-host operations.

See [Auth](./05-auth.md) for the full picture.

## Credential flow

```text
                  ┌──────────────┐
                  │ user PDS     │  mints service-auth JWT (lxm: getCredential)
                  └──────┬───────┘
                         ▼
                  ┌──────────────┐
                  │ authority    │  validates JWT, checks membership,
                  │ (Contrail)   │  signs ES256 credential (2h TTL)
                  └──────┬───────┘
                         │ { credential, expiresAt }
                         ▼
                  ┌──────────────┐
                  │ record host  │  verifies credential signature against
                  │ (Contrail or │  authority DID's published key,
                  │  elsewhere)  │  checks scope/space/expiry, serves request
                  └──────────────┘
```

`space.refreshCredential` re-issues a fresh credential from an unexpired one without going back through the JWT mint dance — useful for long-running clients.

## Enrollment

The record host maintains a local table of which spaces it accepts records for and which authority signs credentials for each. Two ways enrollment happens:

- **Auto-enroll** (default for in-process deployments): the authority's `createSpace` automatically enrolls the new space on the colocated record host. New users see no enrollment surface; it just works.
- **Explicit `recordHost.enroll`**: for split deployments where the authority and record host run in different processes/operators, the owner (or the authority itself) calls `<ns>.recordHost.enroll { spaceUri, authority }` to consent. Idempotent — re-enrolling updates the binding.

A non-enrolled space gets 404 "not-enrolled" on every record-host route. This is the host's consent layer — without it, anyone with a valid credential could create unbounded storage on your host.

## Discovery — binding resolution

When a record host receives a credential, it needs to know whether the credential's `iss` is authorized to sign for that space. Three sources, tried in order:

1. **Local enrollment** — primary on the record host. `(spaceUri → authorityDid)` from the enrollment table.
2. **PDS record** at `at://<owner>/<type>/<key>` — for user-owned DIDs that declared a host via a normal PDS write. Lexicon: `tools.atmo.space.declaration` (or your namespaced variant).
3. **DID-doc service entry** — `#atproto_space_authority` on the owner's DID doc. For provisioned (no-PDS) DIDs.
4. **Owner self-issues** (fallback) — for the trivial case where the owner DID's own key signs credentials.

For in-process deployments, step 1 is the only one that fires. The other resolvers are wired in by deployments that accept credentials from external authorities — see [deployment shapes](./10-deployment-shapes.md).

## Unified `listRecords`

| Call | Returns |
|---|---|
| no auth, no `spaceUri` | public only |
| `?spaceUri=…` + credential or JWT | one space (ACL-gated) |
| credential / JWT, no `spaceUri` | public **unioned** with every space the caller is a member of |

Filters, sorts, hydration, and references work across all three. Records from a space carry a `space: <spaceUri>` field — same on `listRecords`/`getRecord` responses and `watchRecords` stream events.

## Invites

First-class primitive — see [Auth § Invite tokens](./05-auth.md#invite-tokens) for the mechanism. Space-specific: create via `<ns>.invite.create`, redeem via `.redeem` (membership grant) or `?inviteToken=...` query param (read-only bearer grant).

## XRPCs

### Authority routes (`<ns>.space.*` — spec-aligned)
- `createSpace` `getSpace` `listSpaces` `deleteSpace`
- `listMembers` `addMember` `removeMember`
- `getCredential` `refreshCredential`
- `leaveSpace` (contrail extra)

### Record-host routes (`<ns>.space.*` for records, `<ns>.recordHost.*` for management)
- `putRecord` `deleteRecord` `getRecord` `listRecords`
- `uploadBlob` `getBlob` `listBlobs` (when `recordHost.blobs` is configured)
- `recordHost.enroll`

### Contrail extras (`<ns>.spaceExt.*`)
- `whoami` — caller's relationship to a space (extensions plug in via the integration's whoami hook)

### Invite (`<ns>.invite.*`)
- `create` `redeem` `revoke` `list`

## What's not here

- No E2EE (data is operator-readable).
- No FTS on `?spaceUri=…` yet.
- Records still live in the operator's DB rather than user PDSes — federation is greenfield. (See `refs/spaces-spec-mapping.md` for the migration notes.)
- No managing-app routing (join requests, approval queues — see `refs/spaces-later.md`).

The design follows Daniel Holmgren's [permissioned data rough spec](https://dholms.leaflet.pub/3mhj6bcqats2o). When real atproto permissioned repos ship, migration is mostly data movement — the wire surface your app speaks doesn't change.
