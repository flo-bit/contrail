# Spaces

Auth-gated store for records that can't live on public PDSes — private events, invite-only groups, members-only chat. Opt-in; zero cost if you don't enable it.

## Mental model

> A **space** is a bag of records with one lock. The **member list** says who has the key.

- One owner (DID), one type (NSID), one key. Identified by `ats://<owner>/<type>/<key>` — distinct scheme from atproto record URIs (`at://`) so the two can't be confused at any layer.
- Every member (including owner) has read + write inside the space. Delete is scoped to your own records — no one can remove records they didn't author, owner included. To wipe everything, delete the space.
- Optional **app policy** gates which OAuth clients can act in the space.

Every permission boundary is its own space. No nested ACLs. Richer roles = more spaces or app-layer checks.

## Enable

```ts
import type { ContrailConfig } from "@atmo-dev/contrail";

const config: ContrailConfig = {
  namespace: "com.example",
  collections: { /* ... */ },
  spaces: {
    type: "com.example.event.space",
    serviceDid: "did:web:example.com",
  },
};
```

Each collection gets a parallel `spaces_records_<short>` table. Opt out per-collection:

```ts
public_only: { collection: "com.example.public", allowInSpaces: false }
```

## Auth

Spaces use the standard contrail auth surface — service-auth JWTs for third-party apps, in-process server clients for your own loaders, invite tokens for anonymous read-grant links. See [Auth](./05-auth.md) for the full picture.

Space-specific wiring:

- `serviceDid` in the config is the `aud` contrail expects on incoming JWTs. Plain DID, no `#fragment`.
- Apps acting in a space send `Atproto-Proxy: <serviceDid>#<service-id-from-your-did-doc>` so the user's PDS routes correctly.
- Invite redemption via service-auth JWT grants membership; via `?inviteToken=...` query param grants read-only bearer access to that space.

## Unified `listRecords`

| Call | Returns |
|---|---|
| no auth, no `spaceUri` | public only |
| `?spaceUri=…` + JWT | one space (ACL-gated) |
| JWT, no `spaceUri` | public **unioned** with every space the caller is a member of |

Filters, sorts, hydration, and references work across all three. Records from a space carry a `space: <spaceUri>` field — same on `listRecords`/`getRecord` responses and `watchRecords` stream events.

## Invites

First-class primitive — see [Auth § Invite tokens](./05-auth.md#invite-tokens) for the mechanism. Space-specific: create via `com.example.space.invite.create`, redeem via `.redeem` (membership grant) or `?inviteToken=...` query param (read-only bearer grant).

## XRPCs

- `com.example.space.create | get | list | delete`
- `com.example.space.putRecord | deleteRecord | listRecords | getRecord`
- `com.example.space.invite.create | redeem | revoke | list`
- `com.example.space.listMembers | removeMember`

## What's not here

- No E2EE (data is operator-readable).
- No FTS on `?spaceUri=…` yet.
- No per-space sharding — one DB, one operator.
- Not a long-term replacement for real atproto permissioned repos.

The design follows Daniel Holmgren's [permissioned data rough spec](https://dholms.leaflet.pub/3mhj6bcqats2o). The goal is that when real atproto permissioned repos ship, migration is mostly data movement — the API your app speaks doesn't change.
