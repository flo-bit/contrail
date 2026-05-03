# Communities

Group-controlled atproto DIDs. A community is a DID whose signing/rotation keys are held by the appview on behalf of multiple members, with tiered access levels. Built on top of [spaces](./06-spaces.md).

Communities live in a separate package — `@atmo-dev/contrail-community` — that plugs into Contrail via an integration object. The contrail core has no knowledge of community-specific concepts; the package wires itself in via injectable hooks (whoami extension, invite handler, route registration, schema).

## Install

```bash
pnpm add @atmo-dev/contrail @atmo-dev/contrail-community
```

## Wire it up

Construct the integration once, hand it to `Contrail` (or directly to `createApp`):

```ts
import { Contrail, resolveConfig, type ContrailConfig } from "@atmo-dev/contrail";
import { createCommunityIntegration } from "@atmo-dev/contrail-community";

const config: ContrailConfig = {
  namespace: "com.example",
  collections: { /* ... */ },
  spaces: {
    authority: { type: "com.example.event.space", serviceDid: "did:web:example.com", signing },
    recordHost: {},
  },
  community: {
    masterKey: env.COMMUNITY_MASTER_KEY,  // 32-byte encryption key for stored credentials
    serviceDid: "did:web:example.com",
    levels: ["admin", "moderator"],        // ranked, highest-first
  },
};

const resolved = resolveConfig(config);
const communityIntegration = createCommunityIntegration({ db, config: resolved });

const contrail = new Contrail({ ...config, db, communityIntegration });
await contrail.init();   // applies community schema alongside contrail's own
```

Or with `createApp` directly:

```ts
import { createApp, initSchema } from "@atmo-dev/contrail";
import { createCommunityIntegration } from "@atmo-dev/contrail-community";

const community = createCommunityIntegration({ db, config });
await initSchema(db, config, { extraSchemas: [community.applySchema] });
const app = createApp(db, config, { community });
```

Stored credentials (app passwords for adopted communities, signing keys for minted) are envelope-encrypted with `masterKey`. Never ship the placeholder.

## When to use this

When you want atproto records published under a *shared* identity — a team, a project, a channel — not a single user. Think: a group's published calendar events, a community's published posts.

## Two modes

- **Minted** — contrail creates a fresh `did:plc` for the community, holds the signing key plus one rotation key (a second rotation key is returned to the creator once for recovery), and publishes from it.
- **Adopted** — contrail takes over an existing account by holding an **app password** issued from its PDS. The owner's identity, signing key, and rotation keys are unchanged; contrail just gets PDS write access via the app password.

Either way, the result is the same: a DID that multiple members can act through, gated by access levels.

## Access levels

Each member has a level (ranked). Levels map to write permissions. Owners can grant/revoke levels. Two reserved levels exist: `owner` and `member`. Your deployment defines the rest via `config.community.levels`.

## How it composes with spaces

A community *owns* spaces. Members of the community get access to community-owned spaces based on their access level. Grant access per-space per-level:

```
community.space.grant  { spaceUri, subject: { did: "did:plc:..." }, accessLevel: "admin" }
```

The spaces layer stays ignorant of access levels — it just sees "this DID is a member." The community layer projects member × level → membership in specific spaces. Once a DID is a member of a space (through a community grant or otherwise), they have full read + write inside it.

The integration plugs in to two contrail extension points:

- **Whoami** — `<ns>.spaceExt.whoami` returns `accessLevel` for community-owned spaces (the community whoami extension overrides the default binary-membership response).
- **Invites** — the unified `<ns>.invite.*` family dispatches community-owned spaces through the community invite handler (which uses access levels) and user-owned spaces through the spaces module's binary-membership handler.

## XRPCs

- `<ns>.community.mint | adopt | list | delete`
- `<ns>.community.invite.create | redeem | revoke | list`
- `<ns>.community.setAccessLevel | revoke | listMembers`
- `<ns>.community.space.create | grant | revoke | ...` — community-owned spaces
- `<ns>.community.putRecord | deleteRecord` — publish records as the community DID

## What's not here

- No per-record per-level ACLs. Model as spaces.
- No auto-rotation on key compromise yet.
- Adoption can be revoked unilaterally by the owner — they revoke the app password on their PDS and contrail loses write access. (Mint mode is the irreversible one: the creator's recovery rotation key, returned once at mint time, is the only path back if contrail's signing/rotation key is compromised.)

The design follows zicklag's [Arbiter design sketch](https://zicklag.leaflet.pub/3mjrvb5pul224) for group management on atproto. The post is an early design note; our implementation will track it as the spec firms up.
