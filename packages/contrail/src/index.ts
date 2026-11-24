/** Contrail's curated public API. */
export type { LexiconDoc } from "@atcute/lexicon-doc";
export { Contrail } from "./contrail";
export type {
  AppOptions,
  ContrailInitOptions,
  ContrailOptions,
} from "./contrail";

// Configuration, schema helpers, and dialects.
export {
  DEFAULT_COLLECTION_METHODS,
  DEFAULT_CONSTELLATION_URL,
  DEFAULT_FEED_MAX_ITEMS,
  DEFAULT_FOLLOW_NSID,
  DEFAULT_FOLLOW_SHORT,
  DEFAULT_JETSTREAMS,
  DEFAULT_PROFILES,
  DEFAULT_RELAYS,
  countColumnName,
  getNestedValue,
  getRelationField,
  groupedCountColumnName,
  normalizeProfileConfig,
  nsidForShortName,
  recordsTableName,
  resolveCollectionKey,
  resolveConfig,
  shortNameForNsid,
  validateConfig,
} from "./core/types";
export type {
  AtprotoServiceAuthConfig,
  AtprotoServiceAuthMethod,
  CollectionAcquisition,
  CollectionConfig,
  CollectionMethod,
  ConstellationConfig,
  ContrailConfig,
  CustomQueryHandler,
  Database,
  FeedConfig,
  FeedTargetConfig,
  IngestEvent,
  IngestValidationConfig,
  Logger,
  MaintenanceConfig,
  MaintenanceOptimizeConfig,
  MutationSource,
  OrderedSourceConfig,
  PipelineQueryHandler,
  ProfileConfig,
  QueryableField,
  RecordRow,
  RecordSource,
  ReferenceConfig,
  RelationConfig,
  ResolvedContrailConfig,
  SourcePosition,
  Statement,
} from "./core/types";
export {
  buildFtsSchema,
  ftsQueryClause,
  getDialect,
  postgresDialect,
  sqliteDialect,
} from "./core/dialect";
export type { SqlDialect } from "./core/dialect";
export { buildFtsContent, getSearchableFields } from "./core/search";

// Identity and PDS HTTP helpers.
export {
  resolveActor,
  resolveIdentities,
  resolveIdentity,
} from "./core/identity";
export {
  getClient,
  getPDS,
  resolvePDS,
  validateExternalUrl,
} from "./core/client";
export type { ResolvedIdentity } from "./core/client";

// Database schema, queries, cursors, and maintenance.
export { initSchema } from "./core/db/schema";
export type { InitSchemaOptions, SchemaModule } from "./core/db/schema";
export {
  assertServingSourceCompatibility,
  compareRecordVersions,
  getLastCursor,
  getServingSourcePosition,
  orderedSourcePosition,
  queryRecords,
  saveCursor,
} from "./core/db/records";
export type {
  MutationSelection,
  QueryOptions,
  RecordVersionInfo,
  ServingSourcePosition,
  SortOption,
} from "./core/db/records";
export { optimizeDatabase } from "./core/db/optimize";

// Ingestion, backfill, diagnostics, validation, and service auth.
export {
  createIngestEvent,
  ingestRecords,
  recordTimeUs,
} from "./core/ingest";
export type {
  IngestDropCounts,
  IngestProjection,
  IngestRecordsOptions,
  IngestRecordsResult,
  RecordEventInput,
} from "./core/ingest";
export {
  createIngestState,
  ingestEvents,
  runIngestCycle,
} from "./core/jetstream";
export type { IngestState, ScheduledIngestOptions } from "./core/jetstream";
export { JetstreamLiveHistoryExpiredError } from "./core/jetstream-live";
export type { JetstreamLiveEvent } from "./core/jetstream-live";
export { runPersistent } from "./core/persistent";
export type { PersistentIngestOptions } from "./core/persistent";
export {
  backfillPending,
  backfillUser,
  discoverAndBackfill,
  discoverDIDs,
  retryPendingBackfills,
} from "./core/backfill";
export type {
  BackfillAllOptions,
  BackfillRetryOptions,
  BackfillRetryResult,
} from "./core/backfill";
export { getBackfillStatus } from "./core/status";
export type { BackfillStatus } from "./core/status";
export { getIngestDiagnostics } from "./core/diagnostics";
export type { IngestDiagnosticCounts } from "./core/diagnostics";
export {
  bindRecordValidationLexicons,
  bindRecordValidationProvider,
  prepareRecordValidation,
  validateCanonicalRecord,
} from "./core/validation";
export type {
  RecordValidationFailure,
  RecordValidationProvider,
} from "./core/validation";
export {
  createExactServiceAuthGate,
  createServiceAuthGate,
} from "./core/service-auth";
export type {
  ExactServiceAuthConfig,
  ExactServiceAuthGate,
  ServiceAuthGate,
  ServiceAuthResult,
} from "./core/service-auth";
export { formatServiceOAuthScope } from "./service-auth-contract";
export {
  describePublicService,
  normalizePublicServiceEndpoint,
  validateServiceManifest,
} from "./public-service";
export type {
  LexiconDocument,
  PublicServiceAuthContract,
  PublicServiceCollection,
  PublicServiceDescription,
  PublicServiceManifest,
  PublicServiceOptions,
  PublicServiceProtectedMethod,
} from "./public-service";

// HTTP router and query helpers.
export { createApp } from "./core/router";
export type { CreateAppOptions } from "./core/router";
export { getCursorStatus, getStatusOverview } from "./core/router/diagnostics";
export type {
  CollectionOverview,
  CursorStatus,
} from "./core/router/diagnostics";
export {
  MAX_NOTIFY_URIS,
  parseAtUri,
  processNotifyUris,
} from "./core/router/notify";
export type { NotifyResult } from "./core/router/notify";
export { resolveProfiles } from "./core/router/profiles";
export { batchedInQuery } from "./core/router/helpers";

// Moderation and labels.
export {
  BLUESKY_MODERATION_DID,
  MODERATION_ACTION_NSID,
  activeHiddenSql,
  hiddenSubjects,
  initModerationReports,
  isAccountHidden,
  parseModerationAction,
  visibleRecordSql,
} from "./core/moderation";
export type {
  AccountUpdate,
  ModerationAction,
  ModerationConfig,
} from "./core/moderation";
export {
  ModerationReportError,
  createModerationReports,
} from "./core/moderation-reports";
export type {
  ListModerationReportsInput,
  ModerationReportsOptions,
} from "./core/moderation-reports";
export { moderationActionLexicon } from "./lexicons/moderation";
export { extractSelfLabels } from "./core/labels/self";
export type { SelfLabel } from "./core/labels/self";
export { hydrateLabels } from "./core/labels/hydrate";
export type { HydratedLabel } from "./core/labels/hydrate";
export { selectAcceptedLabelers } from "./core/labels/select";
export { applyLabels } from "./core/labels/apply";
export type { IncomingLabel } from "./core/labels/apply";
export {
  runLabelIngestCycle,
  runPersistentLabels,
} from "./core/labels/subscribe";
export type { PersistentLabelsOptions } from "./core/labels/subscribe";
export type {
  LabelRow,
  LabelerCursorRow,
  LabelerSource,
  LabelsConfig,
} from "./core/labels/types";
