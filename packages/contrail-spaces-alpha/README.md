# `@atmo-dev/contrail-spaces-alpha`

Experimental PDS-hosted Spaces synchronization, isolated Contrail projections, and reusable invitation operations. Workspace-private; not deployed or published.

Compatibility tuple:

- Contrail: workspace `0.25.x` (current main, including moderation and feed-pruning fixes)
- Extension: `0.1.0-alpha.0`
- ATProto Spaces: `0.0.0-spaces-alpha-20261029171913` (October 29 release, pinned exactly)

This is an AppView extension, **not a PDS, Space authority, or OAuth session store**. The application owns user OAuth sessions. Public projections and anonymous routes never read private tables.

## Runtime

```ts
import { createSpacesWorker } from '@atmo-dev/contrail-spaces-alpha/worker';

const spaces = createSpacesWorker({
  projection, // Contrail config; each private collection must set validate: true
  lexicons,   // complete pinned record schema bundle, including referenced schemas
  service: {
    endpoint: 'https://events.example',
    audience: 'did:web:events.example#spaces',
  },
  spaceTypes: {
    'events.example.privateEvent': {
      collections: ['community.lexicon.calendar.event', 'community.lexicon.calendar.rsvp'],
      policy: { $type: 'com.atproto.memberspace.policy' },
    },
  },
});

// Only pass a principal authenticated by the application's own session.
const runtime = spaces.integrated(env, ctx);
await runtime.authorizeSpace({ userDid: session.did, space, delegation });
await runtime.getSpaceRecord({ userDid: session.did, space, collection, uri });
```

Create event Spaces with a published memberspace policy from the start:

```ts
import { createSpace } from '@atmo-dev/contrail-spaces-alpha/consumer';

const { uri: space } = await createSpace(ownerSession, {
  spaceType: 'events.example.privateEvent',
  policy: { $type: 'com.atproto.memberspace.policy', publishPolicy: true },
});
```

Both public-access flags default to false. The runtime checks the authority's `com.atproto.space.policy/self` record with a fresh KEM exchange, record MAC, exact URI and CID verification. It never calls owner-only `getSpace` with a Space credential. Unpublished or mismatched policies fail closed; publishing the member list is not required.

For managed Spaces, configure `policy: { $type: 'com.atproto.managedspace.policy', managingApp: service.audience }` and supply `authorization.authorize` for **both** reads and writes. The owner must also enable `publishPolicy`. The callback is `com.atproto.managedspace.checkUserAccess`, including its exact service-auth `lxm`.

Integrated deployment is the default. `standaloneUserApi: true` enables the optional exact-service-authenticated user API. PDS notification callbacks always require exact audience/method/issuer verification. A service audience includes its fragment; account audiences used in credential HTTP signatures are bare account DIDs.

Cloudflare bindings:

- `DB`: D1 database (private tables are separate from all public projection state)
- `SPACES_CREDENTIAL_ENCRYPTION_KEY`: 32-byte base64 secret
- optional `SPACES_QUEUE`: background reconciliation; `waitUntil` is the local fallback
- optional `SPACE_SUBSCRIPTIONS`: Durable Object invalidation hub

Forward the app's scheduled and Queue events to the Spaces handler and route its PDS callbacks through `fetch`. OAuth refresh tokens stay in the app. Credential tokens and their binding keys are encrypted at rest; the private projection and its backups contain plaintext. **Spaces are access-controlled, not end-to-end encrypted.**

Independent work bounds:

```ts
syncBudget: { maxIncrementalOperations: 10, recoveryBatchSize: 50 },
maxRepoStarBytes: 16 * 1024 * 1024,
```

Synchronization authenticates each MAC-bearing response with a fresh P-256 KEM exchange, validates STAR archives completely, and checks whole-repo LtHash state before committing private records. A failed replacement leaves the last verified writer generation visible. Missing writer entries do not prove deletion. Full listing reconciliation repairs missed notifications.

## Invitations

```ts
import {
  createSpaceInvitations, invitationLexicon, invitationUrl,
} from '@atmo-dev/contrail-spaces-alpha/invitations';

const invitations = createSpaceInvitations({
  controlSpaceType: 'events.example.invitations',
  invitationCollection: 'events.example.invitation',
  targets: {
    'events.example.privateEvent': ['community.lexicon.calendar.event'],
  },
  restoreOwnerSession: restoreAppSession, // app-owned OAuth SDK client + shared refresh coordination
  preview: readExactEventPreview,        // trusted in-process read; return selected fields only
});

// Host is authenticated. subjectUri is the host's event record in its Space.
const link = await invitations.create(hostSession, {
  space: eventSpace, uri: subjectUri, expiresAt: '2027-01-01T00:00:00Z',
});
const url = invitationUrl('https://events.example', link);

// No guest login needed; this never adds membership or writes an RSVP.
const eventPreview = await invitations.preview(link);

// Guest is authenticated. This restores the offline host's grant and calls
// native putMember({ read: true, write: true }) on the host's PDS.
const target = await invitations.accept(guestSession, link);

// The app now writes the RSVP with guestSession, into the guest's own Space
// repo, referencing target.uri. This is a separate, retryable operation.

// For a handle invite, resolve the handle to a DID and grant native membership.
await invitations.addMember(hostSession, { space: eventSpace, did: resolvedDid });

// Stops future redemption, without ejecting members who already accepted.
await invitations.revoke(hostSession, link.rkey);
```

`invitationLexicon(collection)` supplies the record definition to publish under your own NSID. Other applications can use that definition and the same native memberships. Do not publish a third party's namespace.

Invitation definitions live on the host's PDS in a separate `self` control Space with the owner-only `com.atproto.personalspace.policy`. Control-space checks use the owner's OAuth session, not a sync credential. The engine rejects any other control policy; it never makes that Space shared. They contain SHA-256 verifiers, **not usable secrets**. The engine refuses public/shared control Spaces and checks target ownership and configured collection allowlists. It does not add members to that control Space. Secrets are 256-bit random values and belong in URL fragments, not query strings, logs, or public records.

Links are reusable and optionally expiring or DID-bound. Anyone possessing a reusable link can view its selected preview and, after login, join. Revocation and membership changes are separate. A redemption already in flight may race with revocation; this is not an atomic single-use or limited-capacity invitation system.

### Application responsibilities

- Authenticate the host/guest before passing their SDK session to these trusted APIs; never accept a browser-supplied DID as identity.
- Request the appropriate Space grants, including host `manage=update` and owner `read_self` for policy/member-list reads (`read` also covers `read_self`). Calendar repo permissions alone are insufficient. Use `spacesIntegratedOAuthScopes` or narrower `formatSpacePermissionScope` calls, including a separate own-control-Space grant.
- Coordinate interactive and background refreshes against the same authoritative session store across Worker isolates. An in-process mutex plus eventually consistent KV is insufficient.
- Keep the invitation through login using protected, short-lived server state or an HttpOnly secure cookie. Do not place the secret in `returnTo` query parameters. Use no-store responses, no-referrer policy, and no third-party analytics on invitation pages.
- Validate the link again on POST acceptance. GET/link crawlers must never grant membership or RSVP. Apply CSRF protection and rate limits to the HTTP adapter.
- The preview callback must read only the verified target and return selected event fields—not references, guest lists, counts, credentials, or the raw invitation. A fresh event can be read directly from the owner's PDS while the private index catches up.
- Distinguish host reconnection from invalid/expired invitations without exposing tokens or raw upstream errors. Offline acceptance requires the host's grant to remain refreshable.
- Store guest RSVPs privately, with a deterministic/reusable record key so retries do not duplicate attendance. Never send them to the public repo or public search/OG/calendar pipelines.

After redemption, another compatible app can use the PDS-enforced membership without Alice's OAuth session. Redemption itself still depends on the issuing application holding a valid host grant. `listSpaces` on a PDS lists written repos, not pending invitations; an invitation inbox is separate work.

## PDS operations

Owner helpers are `createSpace`, `getSpace`, `updateSpacePolicy`, `putSpaceMember`, `removeSpaceMember`, and `listSpaceMembers` from `/consumer`. Policies are explicit `$type` objects.

- `updateSpacePolicy` replaces the entire object. Read, merge, and send the complete policy to preserve other fields. Changing `$type` discards policy state, including members.
- Member methods call `com.atproto.memberspace.*` and only work on memberspaces (`PolicyMismatch` otherwise). Membership removal or `write: false` also removes the upstream writer; this does not delete their records or our verified local copy.
- Managed policies ask the app about both reads and writes. When revoking managed write access, the app must also call the PDS's `com.atproto.space.removeWriter`.
- `SpaceNotFound` means not found **or not authorized**. It pauses failed connections but never purges data. `SpaceDeleted` and authenticated deletion notifications remain the deletion signals.
- Authority PDS changes trigger re-registration even before the registration expires. A cleared repo is recovered from authenticated STAR; an account-migrated repo with unchanged data only advances its checkpoint.

This is an unused pre-release implementation targeting the pinned protocol directly. There are no legacy schema migrations, credential conversions, or upgrade-time reauthorization steps.

## Validation and remaining gates

```sh
pnpm --filter @atmo-dev/contrail build
pnpm --filter @atmo-dev/contrail test
pnpm --filter @atmo-dev/contrail test:built
pnpm --filter @atmo-dev/contrail-spaces-alpha typecheck
pnpm --filter @atmo-dev/contrail-spaces-alpha test
pnpm --filter @atmo-dev/contrail-spaces-alpha build
pnpm --filter @atmo-dev/contrail-spaces-alpha test:workerd
```

The local workerd smoke exercises real signatures, KEM, published-policy record verification, STAR/MAC verification, and isolated D1 initialization without contacting any PDS. It is not a real two-account integration test.

Not shipped yet: RSVP application routes/editor/RSVP wiring, distributed app-session coordination, real-PDS owner+guest evidence, package publication, and deployment. Keep those release gates explicit. Also deferred: blobs, private feeds/labels/profile hydration, arbitrary private SQL, combined public/private pagination, app-attestation allowlists, and invitation discovery/notifications.
