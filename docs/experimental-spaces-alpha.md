# Experimental AT Protocol Spaces support

Contrail's first Spaces-alpha implementation lives in the optional, unpublished `@atmo-dev/contrail-spaces-alpha` workspace package.

The implementation preserves two separate trust boundaries:

1. a DPoP-bound Space credential allows the runtime to synchronize one Space; and
2. the integrated application's authenticated session principal plus exact-Space authorization allows a caller to query its cached projection.

A successful sync credential is never treated as caller authorization. An optional standalone adapter can still replace the trusted application session with exact method-bound AT service JWTs.

## Storage isolation

Public records remain in `records_*` and `record_versions`. Private rows use extension-initialized `isolated_records_*`, `isolated_record_versions`, isolated FTS mappings, and a visible partition-generation map. Anonymous public code cannot address these tables.

A Space incarnation maps to one opaque projection scope. Each writer repo is staged in a new partition generation during full recovery. The visibility pointer and verified checkpoint switch in one database batch, after which the prior generation can be deleted.

## Worker lifecycle

`createSpacesWorker` composes:

- trusted in-process delegation authorization and private queries;
- optional exact-service-authenticated standalone routes;
- native public/member-list policy validation and optional managing-app access checks;
- signed write/deletion notifications;
- Queue consumption;
- scheduled bounded reconciliation;
- renewable, owner-fenced per-repo leases; and
- optional hibernating Durable Object WebSocket invalidations.

Integrated application synchronization always reconciles the authority's complete `listRepos` result; only service-authenticated authority notifications use the targeted writer path. Public and member-list policies remain PDS-owned: successful delegation exchange creates a short-lived provider access lease, while managing-app policies use the configured application callback. `listSpaces` reports owned or currently connected provider watches; the alpha protocol has no inverse global Space-membership query. Rediscovery is accepted only for a watch already hidden by a verified deletion, so an ordinary read-authorized caller cannot rotate an active generation.

PDS notifications only enqueue a target revision/hash. Record bodies always come from authenticated writer hosts and are accepted only after commit/LtHash or full-CAR verification. After the verified projection commit, an optional per-Space Durable Object broadcasts an invalidation—not record contents—to browsers holding a short-lived, one-time ticket issued through the authenticated application session. CAR bodies are size-limited while streaming, including responses without `Content-Length`. Relation-count columns use additive initialization migrations when projection configuration evolves.

## Current limitations

This first alpha supports D1 and the shared SQLite conformance path. PostgreSQL uses the same protocol-neutral isolated schema/query code but has not yet received a live Spaces deployment test. Blobs, private feeds, labels, profile hydration, custom SQL, combined scope queries, and client-attested app allow-lists remain unavailable.

See `apps/spaces-demo` for the integrated deployment.
