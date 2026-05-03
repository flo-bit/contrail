# Deployment shapes

Spaces split into two roles, run together by default. Three deployment shapes, in increasing order of complexity:

1. **All-in-one** — authority + record host + (optional) community in one process. The default; what you get from `createApp` with both `spaces.authority` and `spaces.recordHost` configured. Most apps want this.
2. **Authority-only** — a service that controls ACL and signs credentials, but doesn't store records. Useful when records live on someone else's host (e.g. a community arbiter that delegates storage to a heavier appview).
3. **Record-host-only** — a service that stores records, accepting credentials signed by an external authority. Useful when storage lives separately from governance — e.g. Contrail-as-host backing spaces that an "Arbiter" or HappyView manages.

The split is real at the wire level (different XRPCs, different auth shapes) but the same Contrail codebase handles all three. This doc walks through each.

## Shape 1: all-in-one (default)

```
┌────────────────────────────────────┐
│ Contrail                           │
│  ┌────────┐   ┌────────────┐       │
│  │authority│   │ record host│       │
│  │ + signing│  │ + enrollment│      │
│  └────────┘   └────────────┘       │
│       shared DB, single process    │
└────────────────────────────────────┘
```

Config:

```ts
spaces: {
  authority: {
    type: "com.example.event.space",
    serviceDid: "did:web:example.com",
    signing: await generateAuthoritySigningKey(),
  },
  recordHost: {
    blobs: { adapter: blobsAdapter }, // optional
  },
},
```

What happens at startup:

- `initSchema` creates both authority tables (`spaces`, `spaces_members`, `spaces_invites`) and record-host tables (`spaces_records_<short>`, `spaces_blobs`, `record_host_enrollments`).
- The umbrella router wires `registerAuthorityRoutes` + `registerRecordHostRoutes` against the same `HostedAdapter`.
- The credential verifier is built from `Local` binding + `Local` key — no DID-doc fetches; the host knows the authority's public key directly.

What happens when a user creates a space:

1. `createSpace` writes a row in `spaces` (authority) and immediately a row in `record_host_enrollments` (host). One round-trip, two DB writes.
2. From there, `getCredential` works, `putRecord` works, the world is in sync.

This is the path most apps run. You don't notice the role split.

## Shape 2: authority-only

A lightweight service that holds ACL and signs credentials. Records live on someone else's host.

```
                     ┌────────────────┐
                     │ this Contrail  │
                     │   authority    │
                     └────────────────┘
                          ▲
                          │ getCredential
                          │
                     ┌─────────────┐
                     │   client    │
                     └─────────────┘
                          │ X-Space-Credential
                          ▼
                     ┌─────────────┐
                     │ external    │  enrolled with this authority
                     │ record host │  (different operator, different DID)
                     └─────────────┘
```

Config:

```ts
spaces: {
  authority: {
    type: "com.example.event.space",
    serviceDid: "did:web:authority.example.com",
    signing: await generateAuthoritySigningKey(),
  },
  // recordHost omitted — this deployment doesn't store records
},
```

`createSpace` here does NOT auto-enroll anywhere. The space owner (or the authority itself) calls `recordHost.enroll` on whichever host they want to use; the host then accepts credentials signed by this authority for that space.

The authority's DID document needs to publish the verification key under `#atproto_space_authority` so external hosts can resolve it.

## Shape 3: record-host-only

A storage tier that accepts credentials signed by external authorities.

```
┌────────────┐
│  external  │  signs credentials
│  authority │
└────────────┘
      │
      ▼
┌─────────────────────────────────────┐
│ this Contrail                       │
│   record host (no authority)        │
│                                     │
│   verifies credentials via:         │
│     - enrollment table              │
│     - DID-doc key resolver          │
│       (for external authorities)    │
└─────────────────────────────────────┘
```

Config:

```ts
spaces: {
  // authority is still needed for the JWT verifier infrastructure (so the
  // record host can validate JWTs on the recordHost.enroll endpoint), but
  // no signing key is configured — this deployment doesn't issue creds.
  authority: {
    type: "com.example.event.space",
    serviceDid: "did:web:host.example.com",
  },
  recordHost: {
    blobs: { adapter: blobsAdapter },
  },
},
```

To accept credentials from an external authority, wire a custom verifier:

```ts
import {
  createApp,
  createBindingCredentialVerifier,
  createEnrollmentBindingResolver,
  createDidDocKeyResolver,
} from "@atmo-dev/contrail";
import { CompositeDidDocumentResolver, PlcDidDocumentResolver, WebDidDocumentResolver }
  from "@atcute/identity-resolver";

const didResolver = new CompositeDidDocumentResolver({
  methods: {
    plc: new PlcDidDocumentResolver(),
    web: new WebDidDocumentResolver(),
  },
});

const verifier = createBindingCredentialVerifier({
  // Local enrollment is the canonical binding source — only spaces this
  // host has explicitly opted into are accepted.
  bindings: createEnrollmentBindingResolver({ recordHost: hostAdapter }),
  // For credential signature verification, walk DID docs of external
  // authorities to find their published verification keys.
  keys: createDidDocKeyResolver({ resolver: didResolver }),
});

const app = createApp(db, config, {
  spaces: { credentialVerifier: verifier },
});
```

The flow when a request arrives:

1. Caller presents `X-Space-Credential: <jwt>`.
2. Verifier reads `iss` from the JWT, looks up enrollment for `claims.space`. If the enrollment's `authorityDid` matches `iss` → continue. If not → 401 `unknown-issuer`.
3. Resolves the issuer DID, finds the verification method with id matching the JWT's `kid`, verifies the signature.
4. Checks expiry, scope, space match.
5. Serves the request.

Enrollment is the host's consent layer: a credential can only be presented for spaces the host has agreed to store. Without enrollment, no records get written.

## Mixing shapes

You can run all three simultaneously in one Contrail instance. The umbrella router enables each set of routes based on what's configured:

- `spaces.authority` → authority routes registered (`createSpace`, `getCredential`, etc.)
- `spaces.recordHost` → record-host routes registered (`putRecord`, `recordHost.enroll`, etc.)
- Both → today's default.

A deployment can act as the authority for spaces it owns *and* a record host for spaces other authorities own. Auto-enroll fires only for spaces this deployment is the authority for; external authorities still enroll explicitly.

## Choosing a shape

| Need | Shape |
|---|---|
| One operator, one process, want it to work | All-in-one |
| You're running a "DAO governance / arbiter" service that decides ACL but not storage | Authority-only |
| You're running an appview / heavier storage tier and want to accept ACL decisions from external services | Record-host-only |
| You're an existing Contrail deployment that wants to also accept external authorities | All-in-one + custom verifier |

When in doubt, all-in-one. Splitting is for when you have a real operational reason to separate the two — different teams running them, different latency profiles, different scaling targets, different governance.

## What's not here

- **Authority migration** — moving a space's authority from DID A to DID B. The architecture supports it (re-enroll on the host with the new authority binding) but no helper API yet.
- **Multi-authority per space** — could in principle allow several authorities to all sign for one space (replication scenarios). Not modeled today; spec is silent.
- **PDS-backed records** — when atproto's permissioned-repos protocol ships, records will federate from user PDSes. The host becomes an aggregator rather than a store. The role split here generalizes to that world without changes.
