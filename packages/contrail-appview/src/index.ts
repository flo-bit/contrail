/** @atmo-dev/contrail-appview — public-records appview for contrail.
 *
 *  Owns: jetstream ingestion, backfill, refresh, query layer, per-collection
 *  XRPC routes, feeds, profiles, labels, the umbrella `createApp` that wires
 *  authority + record-host integrations, plus the `HostedAdapter`
 *  composition for in-process deployments.
 *
 *  Re-exported wholesale from each module so consumers don't need to know
 *  internal path layout. */

// Forward base + authority + record-host so a consumer that imports
// `@atmo-dev/contrail-appview` (or a shim that re-exports it) sees the full
// shared surface in one place. Contrail bundle re-exports from here to keep
// its public API surface unchanged.
export * from "@atmo-dev/contrail-base";
export * from "@atmo-dev/contrail-authority";
export * from "@atmo-dev/contrail-record-host";

// Record-sync ingestion (consumer side of recordHost.sync)
export {
  runRecordHostSync,
  buildRecordSyncSchema,
  applyRecordSyncSchema,
} from "./sync";
export type {
  RecordHostSyncSource,
  RecordHostSyncOptions,
} from "./sync";

// Indexing pipeline (jetstream, persistent, backfill, refresh, ingest helpers)
export * from "./core/jetstream";
export * from "./core/persistent";
export * from "./core/backfill";
export * from "./core/refresh";
export * from "./core/search";

// DB
export * from "./core/db/schema";
export * from "./core/db/records";
// note: ./core/db/index is implicitly covered by the wildcard if we export it
// — but we don't, since both schema and records may export overlapping names.
// Tests can import the specifics they need.

// Router (createApp, registerCollectionRoutes, admin, feed, notify, profiles, hydrate)
export * from "./core/router";
export * from "./core/router/notify";
export * from "./core/router/profiles";
export * from "./core/router/feed";
export * from "./core/router/admin";
export * from "./core/router/collection";
export * from "./core/router/hydrate";
export * from "./core/router/helpers";

// Spaces — re-exports + the bundle's HostedAdapter composition
export { HostedAdapter } from "./core/spaces/adapter";
export {
  registerSpacesRoutes,
  registerAuthorityRoutes,
  registerRecordHostRoutes,
} from "./core/spaces/router";
export type {
  SpacesRoutesOptions,
  WhoamiExtension,
} from "./core/spaces/router";

// Realtime
export * from "./core/realtime";

// Labels
export * from "./core/labels/types";
export * from "./core/labels/hydrate";
export * from "./core/labels/select";
export * from "./core/labels/apply";
export * from "./core/labels/subscribe";
export * from "./core/labels/resolve";
export * from "./core/labels/schema";
