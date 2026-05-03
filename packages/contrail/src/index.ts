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

// Space credentials
export {
  generateAuthoritySigningKey,
  signCredential,
  issueCredential,
  verifyCredential,
  decodeUnverifiedClaims,
  createInProcessVerifier,
  createBindingCredentialVerifier,
} from "./core/spaces/credentials";
export type {
  CredentialClaims,
  CredentialKeyMaterial,
  CredentialScope,
  CredentialVerifier,
  VerifyOk,
  VerifyErr,
  VerifyOptions,
} from "./core/spaces/credentials";

// Binding + key resolution
export {
  createLocalBindingResolver,
  createEnrollmentBindingResolver,
  createOwnerSelfBindingResolver,
  createCompositeBindingResolver,
  createPdsBindingResolver,
  createDidDocBindingResolver,
  createLocalKeyResolver,
  createDidDocKeyResolver,
  createCompositeKeyResolver,
} from "./core/spaces/binding";
export type { BindingResolver, KeyResolver } from "./core/spaces/binding";

// Route registration — exposed for split deployments where authority and
// record host run as separate Hono apps. Consumers wire them onto bare Honos
// individually instead of going through createApp's umbrella.
export {
  registerAuthorityRoutes,
  registerRecordHostRoutes,
} from "./core/spaces/router";
export type { EnrollmentRow } from "./core/spaces/types";
export type { WhoamiExtension } from "./core/spaces/router";

// Internal-but-exposed bits — extension packages (community, etc.) need
// these to wire themselves up. Consumer apps generally don't.
export { buildSpaceUri, parseSpaceUri } from "./core/spaces/uri";
export type { ServiceAuth } from "./core/spaces/auth";
export { buildVerifier, createServiceAuthMiddleware } from "./core/spaces/auth";
export { getDialect } from "./core/dialect";
export type { SqlDialect } from "./core/dialect";

// App + schema wiring — extension packages and tests use these.
export { createApp } from "./core/router";
export type { CreateAppOptions, SpacesContext } from "./core/router";
export { initSchema } from "./core/db/schema";
export type { InitSchemaOptions } from "./core/db/schema";

// Community integration interfaces — contrail core defines the shapes
// extension packages implement. The @atmo-dev/contrail-community package
// provides the concrete implementations.
export type {
  CommunityIntegration,
  CommunityProbe,
} from "./core/community-integration";
export type {
  CommunityInviteHandler,
  HandlerResponse,
} from "./core/invite/community-handler";
export type { SchemaModule } from "./core/db/schema";

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

// Community has moved to @atmo-dev/contrail-community. Import from there:
//   import { createCommunityIntegration, CommunityAdapter, ... } from "@atmo-dev/contrail-community";
//   const app = createApp(db, config, { community: createCommunityIntegration(...) });
