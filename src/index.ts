export { Contrail } from "./contrail";
export type { ContrailOptions } from "./contrail";

export type {
  ContrailConfig,
  CollectionConfig,
  RelationConfig,
  ReferenceConfig,
  QueryableField,
  FeedConfig,
  Database,
  Statement,
  Logger,
  IngestEvent,
  RecordRow,
  RecordSource,
  ResolvedContrailConfig,
  ResolvedMaps,
  ResolvedRelation,
  CustomQueryHandler,
  PipelineQueryHandler,
} from "./core/types";

export { resolveConfig, validateConfig } from "./core/types";

export type { QueryOptions, SortOption } from "./core/db/records";
export type { BackfillProgress, BackfillAllOptions } from "./core/backfill";
export type { NotifyResult } from "./core/router/notify";

export { runPersistent } from "./core/persistent";
export type { PersistentIngestOptions } from "./core/persistent";
