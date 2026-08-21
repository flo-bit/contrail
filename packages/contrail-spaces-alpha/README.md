# `@atmo-dev/contrail-spaces-alpha`

Experimental AT Protocol Spaces support for Contrail. This package is intentionally workspace-private while the upstream protocol is alpha.

Pinned compatibility tuple:

- Contrail: workspace `0.18.x`
- Spaces extension: `0.1.0-alpha.0`
- `@atproto/space`: `0.0.0-spaces-alpha-20260818163953`
- supported Lexicons: permissioned-data/Spaces alpha from 2026-08-18

## What it provides

- delegation-token to DPoP-bound Space credential exchange;
- encrypted, expiring provider credential storage;
- explicit Space watches and per-writer checkpoints;
- signed commit, LtHash, and full CAR verification;
- staged writer-generation recovery with atomic visibility cutover;
- incremental repo operation synchronization;
- signed notification routes, Queue jobs, leases, and scheduled reconciliation;
- exact method-bound service authentication;
- delegation access leases or an authoritative application callback;
- explicit support for public, native member-list, and managing-app user policies;
- paginated discovery of owned or currently connected Spaces;
- exact-Space list/get/search/reference/relation-count queries over Contrail's isolated projection seam; and
- optional one-time-ticket, hibernating Durable Object WebSocket invalidations.

Public Contrail tables and anonymous methods are unchanged. Installing the package does not create isolated tables; `createSpacesWorker` initializes them only in a provider deployment.

## Entry points

```ts
import { createSpacesWorker } from "@atmo-dev/contrail-spaces-alpha/worker";
import {
  SpacesProviderClient,
  createSpace,
  createSpaceRecord,
  spacesConsumerOAuthScopes,
} from "@atmo-dev/contrail-spaces-alpha/consumer";
```

The consumer owns OAuth refresh tokens and writes through the user's PDS. The provider receives only one-time delegation evidence, stores an encrypted short-lived credential, verifies permissioned repos, and serves authorized private projections.

## Provider requirements

A Cloudflare deployment needs:

- one D1 database;
- a Queue producer/consumer (with `waitUntil` fallback for development);
- a scheduled trigger;
- a Durable Object binding when `subscriptions` is enabled;
- the `nodejs_compat` compatibility flag; and
- a 32-byte base64 `SPACES_CREDENTIAL_ENCRYPTION_KEY` secret.

Credentials and DPoP private keys are AES-256-GCM encrypted with Space-generation-bound associated data. The D1 projection and backups still contain plaintext private records; this is access control, not end-to-end encryption.

## Deliberately deferred

- blobs;
- private feeds and labels;
- profile hydration;
- arbitrary private custom SQL;
- combined public/private pagination;
- client-attested `appAccess` allow-lists; and
- generic membership or invitation semantics.

See [`apps/spaces-demo-provider`](../../apps/spaces-demo-provider) and [`apps/spaces-demo`](../../apps/spaces-demo) for the complete Worker + SvelteKit example.
