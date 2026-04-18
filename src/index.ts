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

// Spaces
export type {
  SpacesConfig,
  MemberPerm,
  AppPolicy,
  AppPolicyMode,
  SpaceRow,
  SpaceMemberRow,
  StoredRecord,
  StorageAdapter,
  ListOptions,
  ListResult,
  ListSpacesOptions,
  CollectionCount,
  InviteRow,
  CreateInviteInput,
  RedeemInviteResult,
} from "./core/spaces/types";
export { HostedAdapter } from "./core/spaces/adapter";
export { nextTid } from "./core/spaces/tid";
export { generateInviteToken, hashInviteToken } from "./core/spaces/invite-token";
