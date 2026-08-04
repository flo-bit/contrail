/** Contrail's public API. */
export { Contrail } from "./contrail";
export type { AppOptions, ContrailOptions } from "./contrail";

// Configuration, storage, identity, and dialects.
export * from "./core/types";
export * from "./core/dialect";
export * from "./core/identity";
export * from "./core/client";
export * from "./core/sinks/types";

// Ingestion and maintenance.
export * from "./core/ingest";
export * from "./core/jetstream";
export * from "./core/persistent";
export * from "./core/backfill";
export * from "./core/refresh";
export * from "./core/search";
export * from "./core/constellation";

// Database.
export * from "./core/db/schema";
export {
  getFeedPruneCursor,
  getLastCursor,
  lookupExistingRecords,
  pruneActorFeed,
  pruneFeedItems,
  queryRecords,
  saveCursor,
  saveFeedPruneCursor,
  sweepFeedItems,
} from "./core/db/records";
export type {
  ExistingRecordInfo,
  FeedSweepResult,
  QueryOptions,
  SortOption,
} from "./core/db/records";
export * from "./core/db/meta";
export * from "./core/db/optimize";

// HTTP and query pipeline.
export * from "./core/router";
export * from "./core/router/notify";
export * from "./core/router/profiles";
export * from "./core/router/feed";
export * from "./core/router/admin";
export * from "./core/router/collection";
export * from "./core/router/hydrate";
export * from "./core/router/helpers";

// Labels.
export * from "./core/labels/types";
export * from "./core/labels/hydrate";
export * from "./core/labels/select";
export * from "./core/labels/apply";
export * from "./core/labels/subscribe";
export * from "./core/labels/resolve";
export * from "./core/labels/schema";
