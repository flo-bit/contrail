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
export type {
  RefreshOptions,
  RefreshResult,
  RefreshProgress,
  CollectionStats,
} from "./core/refresh";

export { runPersistent } from "./core/persistent";
export type { PersistentIngestOptions } from "./core/persistent";

// Spaces
export type {
  SpacesConfig,
  AuthorityConfig,
  RecordHostConfig,
  SpaceAuthority,
  RecordHost,
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
export { generateInviteToken, hashInviteToken, mintInviteToken } from "./core/invite";
export {
  MemoryBlobAdapter,
  R2BlobAdapter,
  blobKey,
} from "./core/spaces/blob-adapter";
export type { BlobAdapter, BlobUploadMeta, R2BucketLike } from "./core/spaces/blob-adapter";
export type { SpacesBlobsConfig, BlobMetaRow } from "./core/spaces/types";

// Realtime
export type {
  PubSub,
  RealtimeConfig,
  RealtimeEvent,
  RealtimeEventKind,
} from "./core/realtime/types";
export {
  InMemoryPubSub,
  DurableObjectPubSub,
  RealtimePubSubDO,
  TicketSigner,
  wrapWithPublishing,
  sseResponse,
  pumpWebSocket,
  mergeAsyncIterables,
  resolveTopicForCaller,
  actorTopic,
  collectionTopic,
  communityTopic,
  spaceTopic,
  registerRealtimeRoutes,
} from "./core/realtime";
export type {
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectStub,
  DurableObjectState,
} from "./core/realtime/durable-object";

// Labels
export type {
  LabelsConfig,
  LabelerSource,
  LabelRow,
  LabelerCursorRow,
} from "./core/labels/types";
export type { HydratedLabel } from "./core/labels/hydrate";
export { hydrateLabels } from "./core/labels/hydrate";
export { selectAcceptedLabelers } from "./core/labels/select";
export { applyLabels } from "./core/labels/apply";
export type { IncomingLabel } from "./core/labels/apply";
export {
  runLabelIngestCycle,
  runPersistentLabels,
} from "./core/labels/subscribe";
export type { PersistentLabelsOptions } from "./core/labels/subscribe";
export { resolveLabelerEndpoint } from "./core/labels/resolve";

// Community
export {
  CommunityAdapter,
  CredentialCipher,
  registerCommunityRoutes,
  ACCESS_LEVELS,
  RESERVED_KEYS,
  isAccessLevel,
  isReservedKey,
  rankOf,
  resolveEffectiveLevel,
  flattenEffectiveMembers,
  wouldCycle,
  reconcile,
} from "./core/community";
export type {
  CommunityConfig,
  CommunityMode,
  CommunityRow,
  CommunityInviteRow,
  CreateCommunityInviteInput,
  AccessLevel,
  AccessLevelRow,
  ReservedKey,
} from "./core/community";
