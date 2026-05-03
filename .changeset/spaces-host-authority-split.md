---
"@atmo-dev/contrail": minor
"@atmo-dev/contrail-community": minor
"@atmo-dev/contrail-sync": minor
---

Spaces refactor: split authority + record host into independently runnable
roles, add space credentials, extract community into its own package.

**Breaking — config shape**

`spaces` is no longer flat — split into `authority` and `recordHost`:

```ts
// before
spaces: {
  type: "com.example.event.space",
  serviceDid: "did:web:example.com",
  blobs: { adapter, maxSize },
}

// after
spaces: {
  authority: {
    type: "com.example.event.space",
    serviceDid: "did:web:example.com",
    signing: await generateAuthoritySigningKey(),
  },
  recordHost: {
    blobs: { adapter, maxSize },
  },
}
```

**Breaking — community moved to its own package**

Community has been extracted to `@atmo-dev/contrail-community`. Wire it via
`createCommunityIntegration`:

```ts
import { Contrail, resolveConfig } from "@atmo-dev/contrail";
import { createCommunityIntegration } from "@atmo-dev/contrail-community";

const resolved = resolveConfig(config);
const communityIntegration = createCommunityIntegration({ db, config: resolved });
const contrail = new Contrail({ ...config, communityIntegration });
```

The community config (`config.community`) stays the same; only the wiring
moves. Imports of `CommunityAdapter`, `registerCommunityRoutes`,
`reconcile`, etc. now come from `@atmo-dev/contrail-community` instead of
`@atmo-dev/contrail`.

**New — space credentials (`X-Space-Credential`)**

The space authority issues short-lived ES256 JWTs (default 2h TTL) via
`<ns>.space.getCredential` and `refreshCredential`. The record host accepts
them on read/write paths in lieu of per-request service-auth JWTs. Skips
DID-doc fetches and member checks; the credential's signature is the proof.

Generate a signing key once at deploy time:

```ts
import { generateAuthoritySigningKey } from "@atmo-dev/contrail";
const signing = await generateAuthoritySigningKey();
// Store the JWK; pass to spaces.authority.signing.
```

**New — binding resolution**

Verifiers can resolve "which authority signs for this space?" from three
sources, in order: local enrollment table, PDS records at
`at://<owner>/<type>/<key>`, DID-doc `#atproto_space_authority` service
entry, owner-self fallback. Lets user-owned DIDs authorize a third-party
authority via a normal PDS write — no DID-doc surgery.

**New — independent deployments + enrollment**

The authority and record host can run as separate processes/operators.
A new `<ns>.recordHost.enroll` endpoint lets owners (or authorities)
register a space onto a host. In-process deployments auto-enroll on
`createSpace`; nothing changes for single-instance setups.

See `docs/10-deployment-shapes.md` for all-in-one / authority-only /
host-only configurations and when to choose each.

**Migration**

For most deployments running spaces today, the migration is:

1. Update the config: split `spaces.{type, serviceDid, blobs}` into
   `spaces.authority.{type, serviceDid}` and `spaces.recordHost.{blobs}`.
2. Generate and store an authority signing key
   (`generateAuthoritySigningKey()`); add to `spaces.authority.signing`.
3. If using community: install `@atmo-dev/contrail-community`, build
   `createCommunityIntegration({ db, config })`, pass via
   `new Contrail({ communityIntegration })` (or `createApp({ community })`).

Existing service-auth JWT clients keep working as a fallback path.
Migrate to space credentials when convenient — exchange a JWT for a
credential once via `getCredential`, then reuse it.
