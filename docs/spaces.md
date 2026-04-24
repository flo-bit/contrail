# Spaces

Auth-gated store for records that can't live on public PDSes — private events, invite-only groups, members-only chat. Opt-in; zero cost if you don't enable it.

## Mental model

> A **space** is a bag of records with one lock. The **member list** says who has the key.

- One owner (DID), one type (NSID), one key. Identified by `at://<owner>/<type>/<key>`.
- Members have `read` or `write`. Owner is implicit `write`.
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

atproto service-auth JWTs via `@atcute/xrpc-server`. Middleware validates signature, `aud`, and `lxm` before the handler runs. Apps acting in a space mint a JWT against the user's PDS with `Atproto-Proxy: did:web:example.com#com_example_space`, forward to your service, it verifies and executes.

**Note:** Use the plain DID (no `#fragment`) as `serviceDid` — the fragment form only belongs in your DID doc's service entry.

## Unified `listRecords`

| Call | Returns |
|---|---|
| no auth, no `spaceUri` | public only |
| `?spaceUri=…` + JWT | one space (ACL-gated) |
| JWT, no `spaceUri` | public **unioned** with every space the caller is a member of |

Filters, sorts, hydration, and references work across all three. Records from a space carry a `space: <spaceUri>` field.

## Invites

Stored as hashed tokens. Redemption is a single atomic UPDATE that checks `!revoked && !expired && !exhausted`. Generate, hand out the plaintext once, verify later.

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
