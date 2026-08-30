import type { AtprotoAudience } from "@atcute/lexicons/syntax";
import { parseServiceAudience } from "../service-auth-contract.js";
import type { SqlDialect } from "./dialect";

// Database interface — D1 implements this natively
export interface Database {
  prepare(sql: string): Statement;
  batch(stmts: Statement[]): Promise<any[]>;
  dialect?: SqlDialect;
}

export interface Statement {
  bind(...values: any[]): Statement;
  run(): Promise<any>;
  all<T = any>(): Promise<{ results: T[] }>;
  first<T = any>(): Promise<T | null>;
}

// Config types

export interface QueryableField {
  type?: "range";
}

export interface RelationConfig {
  /** Short name of the child collection (a key in `collections`). */
  collection: string;
  field?: string;
  match?: "uri" | "did";
  groupBy?: string;
  /** Enable materialized count columns on the parent. Defaults to true. */
  count?: boolean;
  /** Count distinct values of a field (e.g. "did" for unique users) instead of total records. */
  countDistinct?: string;
  /** Pre-resolved group mappings: shortName → full token (e.g. { going: "community.lexicon.calendar.rsvp#going" }). Auto-computed from groupBy if omitted. */
  groups?: Record<string, string>;
}

/** A forward reference: this collection's records point at another collection. */
export interface ReferenceConfig {
  /** Short name of the target collection. */
  collection: string;
  /** Field on this collection's records containing the target URI. */
  field: string;
}

export type CustomQueryHandler = (
  db: Database,
  params: URLSearchParams,
  config: ContrailConfig
) => Promise<Response>;

export interface RecordSource {
  joins?: string;
  conditions?: string[];
  params?: (string | number)[];
}

export type PipelineQueryHandler = (
  db: Database,
  params: URLSearchParams,
  config: ContrailConfig
) => Promise<RecordSource>;

export interface FeedTargetConfig {
  /** Short name of the target collection. */
  collection: string;
  /** Per-target item cap. Falls back to FeedConfig.maxItems if unset. */
  maxItems?: number;
}

export interface FeedConfig {
  /** Short name of the follow collection. Defaults to "follow"
   *  (auto-added with NSID `app.bsky.graph.follow`, `discover: false`). */
  follow?: string;
  /** Target collections to fan out to. Each entry is either a short name
   *  or `{ collection, maxItems? }` for per-target caps. */
  targets: (string | FeedTargetConfig)[];
  /** Default per-target item cap when a target doesn't specify its own
   *  (default: 200). Oldest items per (actor, collection) are pruned. */
  maxItems?: number;
}

export const DEFAULT_FEED_MAX_ITEMS = 200;
export const DEFAULT_FOLLOW_NSID = "app.bsky.graph.follow";
export const DEFAULT_FOLLOW_SHORT = "follow";

/** Normalize a feed target entry to FeedTargetConfig. */
export function normalizeFeedTarget(
  t: string | FeedTargetConfig
): FeedTargetConfig {
  return typeof t === "string" ? { collection: t } : t;
}

/** Resolve a feed's per-target item cap, falling back to FeedConfig.maxItems then global default. */
export function feedTargetMaxItems(
  feed: FeedConfig,
  target: FeedTargetConfig
): number {
  return target.maxItems ?? feed.maxItems ?? DEFAULT_FEED_MAX_ITEMS;
}

/** Build a Map<target-NSID, maxItems> across all configured feeds, taking the
 *  largest cap if the same target collection appears in multiple feeds. */
export function buildFeedTargetCaps(
  config: ContrailConfig
): Map<string, number> {
  const caps = new Map<string, number>();
  if (!config.feeds) return caps;
  for (const feed of Object.values(config.feeds)) {
    for (const t of feed.targets) {
      const target = normalizeFeedTarget(t);
      const colCfg = config.collections[target.collection];
      if (!colCfg) continue;
      const cap = feedTargetMaxItems(feed, target);
      const nsid = colCfg.collection ?? target.collection;
      const existing = caps.get(nsid) ?? 0;
      if (cap > existing) caps.set(nsid, cap);
    }
  }
  return caps;
}

export type CollectionMethod = "listRecords" | "getRecord";
export const DEFAULT_COLLECTION_METHODS: CollectionMethod[] = [
  "listRecords",
  "getRecord",
];

export interface CollectionConfig {
  /** Full NSID of the record type this collection indexes. May be omitted when
   *  the collection's map key is itself the full NSID (an "NSID-keyed" config);
   *  `resolveConfig` normalizes the omitted value to that key. */
  collection?: string;
  /** Include this collection in Jetstream ingest / discovery (default true).
   *  Set false for dependent collections (auto-fetched on demand). */
  discover?: boolean;
  /** Validate creates/updates against this collection's pinned record Lexicon.
   *  The runtime bundle is supplied by `createWorker({ lexicons })`,
   *  `contrail dev`, or `new Contrail({ lexicons })`. Default: false unless
   *  legacy top-level `validation` enables all collections. */
  validate?: boolean;
  queryable?: Record<string, QueryableField>;
  relations?: Record<string, RelationConfig>;
  /** Forward references: fields on this collection's records that point at another collection. */
  references?: Record<string, ReferenceConfig>;
  queries?: Record<string, CustomQueryHandler>;
  pipelineQueries?: Record<string, PipelineQueryHandler>;
  /** FTS5 search fields. Provide an array of field names to enable full-text search. Omit or set to false to disable. */
  searchable?: string[] | false;
  /** XRPC methods to emit. Defaults to ['listRecords', 'getRecord']. */
  methods?: CollectionMethod[];
  /** JSON field used as record/application time across live ingest, backfill,
   *  notify, and enrichment (clamped to source observation time). Default
   *  `"createdAt"`. Set to `false` to use source observation time. */
  timeField?: string | false;
  /** JSON field on the record holding a DID that this record points at
   *  (e.g. `"subject"` for follows). When set on a `discover: false`
   *  collection, ingest also drops records whose subject DID is not in
   *  knownDids — useful for trimming network-wide social graphs to the
   *  subjects we care about. */
  subjectField?: string;
  /** Per-record predicate run during ingest. Returning false drops the
   *  record before it hits the buffer / DB. Runs only for create/update;
   *  deletes always pass through (the delete may target a record that *did*
   *  pass an earlier version of the filter). Thrown errors are caught,
   *  logged, and treated as "drop". Note: Jetstream filters only by
   *  `wantedCollections`, so non-matching records still travel over the wire
   *  — this trims what gets persisted, not bandwidth. */
  recordFilter?: (record: Record<string, unknown>) => boolean;
}

export interface ProfileConfig {
  /** Full NSID of the profile record type. */
  collection: string;
  /** Short name used for table/endpoint naming. Defaults to the NSID's last segment. */
  shortName?: string;
  rkey?: string; // defaults to "self"
}

export const DEFAULT_PROFILES: ProfileConfig[] = [
  { collection: "app.bsky.actor.profile", shortName: "profile" },
];

/** Normalize a profiles config entry (string or object) into ProfileConfig. */
export function normalizeProfileConfig(
  p: string | ProfileConfig
): ProfileConfig {
  if (typeof p === "string") {
    return { collection: p, shortName: deriveShortName(p) };
  }
  return { ...p, shortName: p.shortName ?? deriveShortName(p.collection) };
}

/** Last NSID segment, used as fallback short name. */
export function deriveShortName(nsid: string): string {
  const parts = nsid.split(".");
  return parts[parts.length - 1] ?? nsid;
}

export const DEFAULT_JETSTREAMS = [
  "https://jetstream.us-east.bsky.network",
];

/** Canonical source identity used for both the v2 client and its durable
 * service binding. The official client addresses XRPC at the origin, so path,
 * query, credentials, and fragments are rejected instead of being discarded
 * ambiguously. WebSocket and HTTP spellings of the same origin are equivalent. */
export function normalizeJetstreamService(service: string): string {
  const url = new URL(service);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Jetstream v2 service must use HTTP(S) or WS(S)");
  }
  if (
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Jetstream v2 service must be an origin URL");
  }
  return url.origin;
}

/** Return the one pinned Jetstream v2 service used by live ingestion.
 * Sequence cursors are instance-local and cannot fail over between services. */
export function jetstreamService(jetstreams: string[]): string {
  if (jetstreams.length !== 1 || !jetstreams[0]) {
    throw new TypeError(
      "Jetstream v2 ingestion requires exactly one pinned service",
    );
  }
  return normalizeJetstreamService(jetstreams[0]);
}

/**
 * Shape a configured jetstream list for the legacy `@atcute/jetstream` adapter
 * still used by v1 archive/bootstrap integrations.
 *
 * @atcute distinguishes a string url (one fixed instance) from an array url (a
 * pool it picks from at random each connect). For an array it seeds
 * `#lastUsedUrl=''` and rolls the cursor back 10s on the first connect, to absorb
 * clock skew between whichever pooled instances a resumed cursor may have
 * crossed. A string takes no rollback: a single instance emits a monotonic
 * cursor, so resuming at the saved value on that same instance can't skip its own
 * events — there is no second instance to be skewed against.
 *
 * Contrail's cron ingestion rebuilds the subscription every cycle, so for a
 * single-instance config that "first-connect" rollback fires *every* cycle and
 * redundantly re-ingests the last 10s. Collapsing a one-element pool to a string
 * matches @atcute's own single-instance semantics and drops that dead margin; a
 * real pool (2+) stays an array so the cross-instance rollback is preserved.
 */
export function jetstreamUrlOption(jetstreams: string[]): string | string[] {
  return jetstreams.length === 1 ? jetstreams[0] : jetstreams;
}

export const DEFAULT_RELAYS = [
  "https://relay1.us-east.bsky.network"
];

export interface Logger {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

export interface IngestValidationConfig {
  /** Recompute authoritative record CIDs from canonical DAG-CBOR (default true). */
  verifyCid?: boolean;
  /** Enforce strict blob size/MIME constraints as well as normal Lexicon rules (default true). */
  strict?: boolean;
  /** Sources allowed to emit CID-less creates/updates. Defaults to local/synthetic sources only. */
  allowCidlessSources?: string[];
}

export interface OrderedSourceConfig {
  /** Stable logical identifier of the primary ordered change source. */
  source: string;
  /** Operator-owned continuity epoch. Change it whenever cursor continuity changes. */
  epoch: string;
}

/** How an accepted mutation entered the logical projection. */
export type ProjectionPhase = "historical" | "live";

export type ChangeConsumerInitialMode = "current" | "future" | "history";

/** Static, secret-free definition for one durable change-log consumer. */
export interface ChangeConsumerConfig {
  /** Exact configured collection NSIDs. Short aliases are deliberately rejected. */
  collections: string[];
  /** Projection phases to observe. Defaults to both; `initial: "current"` requires both. */
  phases?: ProjectionPhase[];
  /** How the consumer establishes its first durable position. */
  initial: ChangeConsumerInitialMode;
  /** Whether deployment generation activation may require this consumer. */
  requiredForActivation?: boolean;
}

export interface ChangeLogConfig {
  /** Stable consumer IDs mapped to their static delivery policy. */
  consumers: Record<string, ChangeConsumerConfig>;
}

export type AtprotoServiceAuthMethod = "getFeed" | "notifyOfUpdate";

export interface AtprotoServiceAuthConfig {
  /** Exact fragmented service reference used as the OAuth and JWT audience. */
  audience: AtprotoAudience;
  /** Built-in methods that require a method-bound AT Protocol service token. */
  methods: AtprotoServiceAuthMethod[];
  /** Maximum accepted token lifetime and age. Default: 300 seconds. */
  maxTokenAgeSeconds?: number;
  /** Optional DID resolver for private networks or controlled resolution. */
  resolver?: import("@atcute/identity-resolver").DidDocumentResolver;
}

export interface ContrailConfig {
  namespace: string;
  /** Collections to index, keyed by short name. Short names become endpoint URL segments
   *  (`<namespace>.<short>.listRecords`) and table suffixes (`records_<short>`). */
  collections: Record<string, CollectionConfig>;
  /** Optional shared runtime Lexicon and CID validation. When configured,
   * every create/update from every source passes through it before projection. */
  validation?: IngestValidationConfig;
  profiles?: (string | ProfileConfig)[];
  relays?: string[];
  /** Jetstream v2 service used for live ingestion (defaults to
   * {@link DEFAULT_JETSTREAMS}). Exactly one service is required: v2 sequence
   * cursors are instance-local and cannot fail over between servers. The array
   * shape is retained for configuration compatibility and will be simplified in
   * a later API cleanup. */
  jetstreams?: string[];
  /** Identity of the ordered source consumed by live ingestion. Its opaque
   * cursor is persisted atomically with projected mutations and may be exposed
   * to clients as a cache invalidation coordinate. */
  orderedSource?: OrderedSourceConfig;
  /** Optional transactional projection change log. Runtime handlers and
   * destination credentials are bound separately and never belong here. */
  changes?: ChangeLogConfig;
  feeds?: Record<string, FeedConfig>;
  logger?: Logger;
  /** Expose the notifyOfUpdate HTTP endpoint. Off by default.
   *  Set to `true` for open access, or a string to require `Authorization: Bearer <secret>`.
   *  Prefer `serviceAuth.methods: ["notifyOfUpdate"]` for portable user auth. */
  notify?: boolean | string;
  /** Verify method-bound AT Protocol service JWTs for selected built-in routes. */
  serviceAuth?: AtprotoServiceAuthConfig;
  /** Labels module configuration. When set, contrail subscribes to the
   *  configured labelers, indexes their labels into a single `labels` table,
   *  and hydrates `record.labels` onto `listRecords` / `getRecord` / profile
   *  responses gated by the caller's `atproto-accept-labelers` header. */
  labels?: import("./labels/types").LabelsConfig;
  /** Constellation-backed reverse-follower lookup (default: enabled).
   *  When a DID is first seen producing a discoverable record, contrail
   *  queries Constellation for follow records pointing at that DID and
   *  ingests synthesized rows for any follower already in our identities
   *  table. Lets newcomers immediately appear in existing users' feeds. */
  constellation?: ConstellationConfig | false;
  /** Network overrides for private-network or test deployments.
   *  All subfields default to current public-internet behavior;
   *  omitting `networkOverrides` entirely preserves current behavior.
   *
   *  SECURITY: `resolver` and `slingshotUrl` are taken at face value and are
   *  NOT validated against the SSRF guard — the consumer is trusted to
   *  configure them. Only the PDS URL returned downstream is validated,
   *  and only `additionalAllowedHosts` widens that PDS validator. There is
   *  no "disable SSRF" flag. */
  networkOverrides?: {
    /** DID document resolver used during the DID-doc PDS fallback. When
     *  unset, contrail constructs a default `CompositeDidDocumentResolver`
     *  with PLC + Web methods pointing at the upstream PLC directory.
     *  Pass a custom resolver to point at a private PLC mirror, inject a
     *  custom fetch (mTLS, retry, instrumentation), or swap in an
     *  alternative DID method composition. */
    resolver?: import("@atcute/identity-resolver").DidDocumentResolver;
    /** Slingshot identity resolver URL override. Trusted; not SSRF-checked.
     *  Default: https://slingshot.microcosm.blue/xrpc/com.bad-example.identity.resolveMiniDoc */
    slingshotUrl?: string;
    /** Hostnames (DNS names or IP literals) to allow past the default SSRF
     *  guard when validating a resolved PDS URL.
     *  For listed hostnames, the non-HTTPS + private-CIDR checks are skipped.
     *  For all other hostnames, the default validator runs unchanged.
     *  Match semantics: exact hostname, case-insensitive (entries are
     *  lowercased on comparison; `URL.hostname` is already lowercased),
     *  port-agnostic.
     *  Example: ["pds.dev.svc.cluster.local"]. */
    additionalAllowedHosts?: string[];
  };
  /** Optional background database maintenance. All off by default. */
  maintenance?: MaintenanceConfig;
}

export interface MaintenanceConfig {
  /** Periodically refresh the SQLite query planner's statistics so
   *  multi-predicate queries pick the selective index instead of the planner's
   *  default heuristic (measured ~50x fewer rows read on a 2-predicate query).
   *  Off by default — it's a DB write + CPU and shouldn't change behavior for
   *  existing consumers unless enabled. `true` uses defaults; pass an object to
   *  tune. No-op on Postgres, where autovacuum/autoanalyze handles this. */
  optimize?: boolean | MaintenanceOptimizeConfig;
}

export interface MaintenanceOptimizeConfig {
  /** Minimum gap between optimize runs (default: 24h). Planner stats change
   *  slowly, so daily is plenty. */
  intervalMs?: number;
  /** `PRAGMA analysis_limit` — bounds the work per run so it can't exceed
   *  D1's per-query CPU budget and reset the shared DO (default: 400). */
  analysisLimit?: number;
}

export const DEFAULT_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ANALYSIS_LIMIT = 400;

/** Whether the opt-in planner-stat maintenance is enabled. */
export function optimizeEnabled(config: ContrailConfig): boolean {
  return !!config.maintenance?.optimize;
}

/** Resolved optimize interval (ms), falling back to the 24h default. */
export function optimizeIntervalMs(config: ContrailConfig): number {
  const o = config.maintenance?.optimize;
  if (o && typeof o === "object" && o.intervalMs != null) return o.intervalMs;
  return DEFAULT_OPTIMIZE_INTERVAL_MS;
}

/** Resolved `analysis_limit` for optimize, falling back to the default. */
export function optimizeAnalysisLimit(config: ContrailConfig): number {
  const o = config.maintenance?.optimize;
  if (o && typeof o === "object" && o.analysisLimit != null) return o.analysisLimit;
  return DEFAULT_ANALYSIS_LIMIT;
}

export interface ConstellationConfig {
  /** Override the default Constellation instance URL. */
  url?: string;
  /** Sent as the User-Agent header per Constellation's request that
   *  callers identify themselves. Defaults to `contrail/<namespace>`. */
  userAgent?: string;
  /** Set false to disable lookups while keeping the table around. */
  enabled?: boolean;
}

export const DEFAULT_CONSTELLATION_URL = "https://constellation.microcosm.blue";

export interface ResolvedRelation {
  /** Short name of the child collection. */
  collection: string;
  groupBy: string;
  groups: Record<string, string>; // shortName → full token value
}

export interface ResolvedMaps {
  queryable: Record<string, Record<string, QueryableField>>;
  relations: Record<string, Record<string, ResolvedRelation>>;
  /** Reverse map: full record NSID → short name. */
  nsidToShort: Record<string, string>;
}

/** Config after resolveConfig() — has computed queryable/relation maps attached. */
export interface ResolvedContrailConfig extends ContrailConfig {
  _resolved: ResolvedMaps;
}

/**
 * Resolve config: apply defaults, auto-add profile collections, compute queryable maps.
 */
export function resolveConfig(config: ContrailConfig): ResolvedContrailConfig {
  if (
    config.orderedSource &&
    (!config.orderedSource.source.trim() || !config.orderedSource.epoch.trim())
  ) {
    throw new TypeError("orderedSource requires non-empty source and epoch values");
  }
  if (config.serviceAuth) {
    try {
      parseServiceAudience(config.serviceAuth.audience);
    } catch (error) {
      throw new TypeError(
        `serviceAuth.audience must be an absolute AT Protocol DID service reference: ${(error as Error).message}`,
      );
    }
    if (
      !Array.isArray(config.serviceAuth.methods) ||
      new Set(config.serviceAuth.methods).size !== config.serviceAuth.methods.length
    ) {
      throw new TypeError("serviceAuth.methods must contain unique methods");
    }
    if (
      config.serviceAuth.methods.includes("getFeed") &&
      (!config.feeds || Object.keys(config.feeds).length === 0)
    ) {
      throw new TypeError("serviceAuth cannot protect getFeed without configured feeds");
    }
    if (
      config.serviceAuth.methods.includes("notifyOfUpdate") &&
      config.notify !== true
    ) {
      throw new TypeError(
        "serviceAuth notifyOfUpdate requires notify: true and replaces shared-secret auth",
      );
    }
    if (
      config.serviceAuth.maxTokenAgeSeconds !== undefined &&
      (!Number.isSafeInteger(config.serviceAuth.maxTokenAgeSeconds) ||
        config.serviceAuth.maxTokenAgeSeconds <= 0)
    ) {
      throw new TypeError("serviceAuth.maxTokenAgeSeconds must be a positive integer");
    }
  }
  const profiles = (config.profiles ?? DEFAULT_PROFILES).map(
    normalizeProfileConfig
  );
  const collections: Record<string, CollectionConfig> = {};

  // Normalize an omitted `collection` (NSID-keyed config) to the map key, then
  // default `discover: false` for any collection whose NSID lives under the
  // `app.bsky.*` namespace, since these are external/network-wide records that
  // would otherwise blow up storage if left discoverable.
  for (const [short, rawC] of Object.entries(config.collections)) {
    const c =
      rawC.collection === undefined ? { ...rawC, collection: short } : rawC;
    collections[short] =
      c.discover === undefined && c.collection!.startsWith("app.bsky.")
        ? { ...c, discover: false }
        : c;
  }

  for (const p of profiles) {
    const short = p.shortName!;
    if (!collections[short]) {
      collections[short] = {
        collection: p.collection,
        discover: false,
        // Hydration needs indexed records, not another generic public surface.
        // Explicit collection declarations can opt these methods back in.
        methods: [],
      };
    }
  }

  // Auto-add a follow collection for any feed that doesn't declare one.
  // Default short name `follow` → `app.bsky.graph.follow`, with a `subject`
  // filter so we only persist follows pointing at known DIDs.
  const feeds = config.feeds;
  if (feeds) {
    const usedFollowShorts = new Set<string>();
    for (const [, feed] of Object.entries(feeds)) {
      const shortName = feed.follow ?? DEFAULT_FOLLOW_SHORT;
      usedFollowShorts.add(shortName);
    }
    for (const short of usedFollowShorts) {
      if (!collections[short]) {
        collections[short] = {
          collection: DEFAULT_FOLLOW_NSID,
          discover: false,
          subjectField: "subject",
          // Feed internals should not create public collection methods unless
          // the collection was explicitly declared by the application.
          methods: [],
        };
      }
    }
  }

  const base = {
    ...config,
    collections,
    profiles,
    jetstreams: config.jetstreams ?? DEFAULT_JETSTREAMS,
    relays: config.relays ?? DEFAULT_RELAYS,
    logger: config.logger ?? console,
  };

  return {
    ...base,
    _resolved: _resolveQueryableMaps(base),
  };
}

function _resolveQueryableMaps(config: ContrailConfig): ResolvedMaps {
  const queryable: Record<string, Record<string, QueryableField>> = {};
  const relations: Record<string, Record<string, ResolvedRelation>> = {};
  const nsidToShort: Record<string, string> = {};

  for (const [short, colConfig] of Object.entries(config.collections)) {
    nsidToShort[colConfig.collection ?? short] = short;

    if (colConfig.queryable) {
      queryable[short] = colConfig.queryable;
    }

    if (colConfig.relations) {
      for (const [relName, rel] of Object.entries(colConfig.relations)) {
        if (!rel.groupBy) continue;
        const groups: Record<string, string> = rel.groups ? { ...rel.groups } : {};
        if (Object.keys(groups).length > 0) {
          if (!relations[short]) relations[short] = {};
          relations[short][relName] = {
            collection: rel.collection,
            groupBy: rel.groupBy,
            groups,
          };
        }
      }
    }
  }

  return { queryable, relations, nsidToShort };
}

export function getFeedFollowShortNames(config: ContrailConfig): string[] {
  if (!config.feeds) return [];
  return [
    ...new Set(
      Object.values(config.feeds).map((f) => f.follow ?? DEFAULT_FOLLOW_SHORT)
    ),
  ];
}

/** Alias for getFeedFollowShortNames. */
export const getFeedFollowCollections = getFeedFollowShortNames;

/**
 * NSIDs whose ingest can mutate `feed_items`: feed *target* collections (a
 * create/update fans out to followers, a delete tears the item down) and feed
 * *follow* collections (a follow backfills the follower's feed, an unfollow
 * removes it). These are the only records that can push a feed over its cap, so
 * a tick that ingested none of them cannot have created prune work — callers use
 * this to skip the feed sweep on idle ticks. Returns an empty set when no feeds
 * are configured. */
export function getFeedMutatingNsids(config: ContrailConfig): Set<string> {
  const nsids = new Set<string>();
  if (!config.feeds) return nsids;
  for (const targetNsid of buildFeedTargetCaps(config).keys()) {
    nsids.add(targetNsid);
  }
  for (const short of getFeedFollowShortNames(config)) {
    const nsid = nsidForShortName(config, short);
    if (nsid) nsids.add(nsid);
  }
  return nsids;
}

// Record types

export interface RecordRow {
  uri: string;
  did: string;
  collection: string; // full NSID
  rkey: string;
  cid: string | null;
  record: string | null;
  time_us: number;
  indexed_at: number;
}

export interface MutationSource {
  /** Stable logical source identifier, for example `jetstream` or `pds-backfill`. */
  id: string;
  /** Continuity epoch for opaque cursors. Missing on legacy adapters. */
  epoch?: string | null;
  /** Source observation/event time, independent of record application time. */
  time_us: number;
  /** Monotonic repository revision when the source provides one. */
  revision: string | null;
  /** Source checkpoint or event position when the source provides one. */
  cursor: string | null;
}

export interface IngestEvent {
  uri: string;
  did: string;
  collection: string; // full NSID
  rkey: string;
  operation: "create" | "update" | "delete";
  cid: string | null;
  record: string | null;
  /** Record/application time used by queries and feeds. */
  time_us: number;
  /** Local projection time. */
  indexed_at: number;
  /**
   * Authoritative source ordering metadata. Optional only for compatibility
   * with callers that constructed IngestEvent objects before 0.13.1; source
   * adapters and createIngestEvent always populate it.
   */
  source?: MutationSource;
}

// Validation

const SAFE_FIELD_NAME = /^[a-zA-Z0-9_.]+$/;
const SAFE_SHORT_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

export function validateFieldName(field: string): string {
  if (!SAFE_FIELD_NAME.test(field)) {
    throw new Error(`Invalid field name: ${field}`);
  }
  return field;
}

function validateShortName(short: string): void {
  if (!SAFE_SHORT_NAME.test(short)) {
    throw new Error(
      `Invalid collection short name: "${short}". Must be alphanumeric, starting with a letter.`
    );
  }
}

const CHANGE_CONSUMER_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_CHANGE_CONSUMERS = 32;
const MAX_CHANGE_CONSUMER_COLLECTIONS = 64;
const MAX_CHANGE_COVERAGE_PAIRS = 256;
const MAX_CHANGE_DEFINITIONS_BYTES = 64 * 1_024;

/** Locale-independent order for durable definitions compared across runtimes. */
function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Whether this configuration requires the optional transactional change log. */
export function changesEnabled(config: ContrailConfig): boolean {
  return Object.keys(config.changes?.consumers ?? {}).length > 0;
}

/** Canonical phases for a consumer definition. */
export function changeConsumerPhases(
  consumer: ChangeConsumerConfig,
): ProjectionPhase[] {
  return consumer.phases ?? ["historical", "live"];
}

/** Canonical collection/phase pairs whose changes must be retained. */
export function changeLogCoverage(
  config: ContrailConfig,
): Array<{ collection: string; phase: ProjectionPhase }> {
  const pairs = new Map<string, { collection: string; phase: ProjectionPhase }>();
  for (const consumer of Object.values(config.changes?.consumers ?? {})) {
    for (const collection of consumer.collections) {
      for (const phase of changeConsumerPhases(consumer)) {
        pairs.set(`${collection}\0${phase}`, { collection, phase });
      }
    }
  }
  return [...pairs.values()].sort(
    (left, right) =>
      compareCanonicalText(left.collection, right.collection) ||
      compareCanonicalText(left.phase, right.phase),
  );
}

/** Stable secret-free representation used by schema/config compatibility checks. */
export function canonicalChangeDefinitions(config: ContrailConfig): string {
  return JSON.stringify(
    Object.entries(config.changes?.consumers ?? {})
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([id, consumer]) => ({
        id,
        collections: [...consumer.collections].sort(),
        phases: [...changeConsumerPhases(consumer)].sort(),
        initial: consumer.initial,
        requiredForActivation: consumer.requiredForActivation === true,
      })),
  );
}

export function validateConfig(config: ContrailConfig): void {
  const shortNames = new Set<string>();
  for (const [short, colConfig] of Object.entries(config.collections)) {
    // NSID-keyed collections use the map key as the NSID (no short alias), so
    // the key legitimately contains dots and must skip short-name validation.
    const nsidKeyed =
      colConfig.collection === undefined || colConfig.collection === short;
    if (!nsidKeyed) validateShortName(short);
    if (shortNames.has(short)) {
      throw new Error(`Duplicate collection short name: ${short}`);
    }
    shortNames.add(short);

    for (const field of Object.keys(colConfig.queryable ?? {})) {
      validateFieldName(field);
    }
    for (const [, rel] of Object.entries(colConfig.relations ?? {})) {
      if (rel.field) validateFieldName(rel.field);
      if (rel.groupBy) validateFieldName(rel.groupBy);
      if (rel.countDistinct) validateFieldName(rel.countDistinct);
      if (!config.collections[rel.collection]) {
        throw new Error(
          `Relation in "${short}" references unknown collection short name "${rel.collection}"`
        );
      }
    }
    for (const [, ref] of Object.entries(colConfig.references ?? {})) {
      validateFieldName(ref.field);
      if (!config.collections[ref.collection]) {
        throw new Error(
          `Reference in "${short}" references unknown collection short name "${ref.collection}"`
        );
      }
    }
    if (Array.isArray(colConfig.searchable)) {
      for (const field of colConfig.searchable) {
        validateFieldName(field);
      }
    }
  }

  if (config.feeds) {
    for (const [feedName, feed] of Object.entries(config.feeds)) {
      const followShort = feed.follow ?? DEFAULT_FOLLOW_SHORT;
      if (!config.collections[followShort]) {
        throw new Error(
          `Feed "${feedName}" references unknown follow collection "${followShort}"`
        );
      }
      for (const t of feed.targets) {
        const targetShort = normalizeFeedTarget(t).collection;
        if (!config.collections[targetShort]) {
          throw new Error(
            `Feed "${feedName}" references unknown target collection "${targetShort}"`
          );
        }
      }
    }
  }

  const consumers = Object.entries(config.changes?.consumers ?? {});
  if (consumers.length > MAX_CHANGE_CONSUMERS) {
    throw new Error(`changes supports at most ${MAX_CHANGE_CONSUMERS} consumers`);
  }
  const configuredNsids = new Set(getCollectionNsids(config));
  for (const [id, consumer] of consumers) {
    if (!CHANGE_CONSUMER_ID.test(id)) {
      throw new Error(
        `Invalid change consumer ID "${id}"; use 1-64 letters, digits, underscores, or hyphens`,
      );
    }
    if (
      !Array.isArray(consumer.collections) ||
      consumer.collections.length === 0 ||
      consumer.collections.length > MAX_CHANGE_CONSUMER_COLLECTIONS ||
      new Set(consumer.collections).size !== consumer.collections.length
    ) {
      throw new Error(
        `Change consumer "${id}" requires 1-${MAX_CHANGE_CONSUMER_COLLECTIONS} unique collection NSIDs`,
      );
    }
    for (const collection of consumer.collections) {
      if (!configuredNsids.has(collection)) {
        throw new Error(
          `Change consumer "${id}" references unconfigured collection NSID "${collection}"`,
        );
      }
    }
    const phases = changeConsumerPhases(consumer);
    if (
      phases.length === 0 ||
      phases.length > 2 ||
      new Set(phases).size !== phases.length ||
      phases.some((phase) => phase !== "historical" && phase !== "live")
    ) {
      throw new Error(
        `Change consumer "${id}" requires unique historical/live phases`,
      );
    }
    if (
      consumer.initial === "current" &&
      !(phases.includes("historical") && phases.includes("live"))
    ) {
      throw new Error(
        `Current-state change consumer "${id}" must observe both historical and live phases`,
      );
    }
    if (!(["current", "future", "history"] as string[]).includes(consumer.initial)) {
      throw new Error(`Change consumer "${id}" has an invalid initial mode`);
    }
  }
  const coveragePairs = changeLogCoverage(config).length;
  if (coveragePairs > MAX_CHANGE_COVERAGE_PAIRS) {
    throw new Error(
      `changes requires ${coveragePairs} collection/phase coverage pairs; maximum is ${MAX_CHANGE_COVERAGE_PAIRS}`,
    );
  }
  const definitionBytes = new TextEncoder().encode(
    canonicalChangeDefinitions(config),
  ).byteLength;
  if (definitionBytes > MAX_CHANGE_DEFINITIONS_BYTES) {
    throw new Error(
      `changes definitions contain ${definitionBytes} encoded bytes; maximum is ${MAX_CHANGE_DEFINITIONS_BYTES}`,
    );
  }

}

// Helpers

export function getNestedValue(obj: any, path: string): any {
  let current = obj;
  for (const key of path.split(".")) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

const DEFAULT_RELATION_FIELD = "subject.uri";

export function getRelationField(rel: RelationConfig): string {
  return rel.field ?? DEFAULT_RELATION_FIELD;
}

/** Sanitize a short name for use in SQL identifiers (already-validated; kept for paranoia). */
function sanitizeIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

/** Total-count column name for a relation targeting the given short name. */
export function countColumnName(childShortName: string): string {
  return "count_" + sanitizeIdentifier(childShortName);
}

/** Grouped-count column name: `count_<child-short>_<groupKey>`. */
export function groupedCountColumnName(
  childShortName: string,
  groupKey: string
): string {
  return `count_${sanitizeIdentifier(childShortName)}_${sanitizeIdentifier(groupKey)}`;
}

/** Table name for a collection's records. */
export function recordsTableName(shortName: string): string {
  return "records_" + sanitizeIdentifier(shortName);
}

/** All collection short names. */
export function getCollectionShortNames(config: ContrailConfig): string[] {
  return Object.keys(config.collections);
}

/** Alias: collection short names (same as getCollectionShortNames). */
export const getCollectionNames = getCollectionShortNames;

/** All indexed record NSIDs (what Jetstream filters on). For NSID-keyed
 *  collections (omitted `collection`), the map key is the NSID. */
export function getCollectionNsids(config: ContrailConfig): string[] {
  return Object.entries(config.collections).map(([short, c]) => c.collection ?? short);
}

export function getDependentShortNames(config: ContrailConfig): string[] {
  return Object.entries(config.collections)
    .filter(([, c]) => c.discover === false)
    .map(([name]) => name);
}

export function getDiscoverableShortNames(config: ContrailConfig): string[] {
  return Object.entries(config.collections)
    .filter(([, c]) => c.discover !== false)
    .map(([name]) => name);
}

/** Aliases for readability elsewhere. These return short names (new semantic). */
export const getDependentCollections = getDependentShortNames;
export const getDiscoverableCollections = getDiscoverableShortNames;

/** Short names of collections the user declared with `discover !== false`, mapped to NSIDs. */
export function getDiscoverableNsids(config: ContrailConfig): string[] {
  return Object.entries(config.collections)
    .filter(([, c]) => c.discover !== false)
    .map(([short, c]) => c.collection ?? short);
}

export function getDependentNsids(config: ContrailConfig): string[] {
  return Object.entries(config.collections)
    .filter(([, c]) => c.discover === false)
    .map(([short, c]) => c.collection ?? short);
}

/** Short name for a record NSID, if known. */
export function shortNameForNsid(
  config: ContrailConfig,
  nsid: string
): string | undefined {
  const resolved = (config as ResolvedContrailConfig)._resolved;
  if (resolved?.nsidToShort) return resolved.nsidToShort[nsid];
  for (const [short, c] of Object.entries(config.collections)) {
    if ((c.collection ?? short) === nsid) return short;
  }
  return undefined;
}

/** The config key a collection's rows are stored under: its short alias when
 *  one exists, otherwise the NSID itself when the config is keyed directly by
 *  NSID. Returns null when the collection is unknown. Use this wherever you need
 *  the storage key (records insert, FTS, existing-record lookup). Unlike
 *  {@link shortNameForNsid}, which only reports an alias and so returns
 *  undefined for NSID-keyed configs. */
export function resolveCollectionKey(
  config: ContrailConfig,
  nsid: string
): string | null {
  return (
    shortNameForNsid(config, nsid) ??
    (config.collections[nsid] ? nsid : null)
  );
}

/** Full NSID for a collection short name. For NSID-keyed collections (omitted
 *  `collection`), the short name is itself the NSID. */
export function nsidForShortName(
  config: ContrailConfig,
  short: string
): string | undefined {
  const c = config.collections[short];
  if (!c) return undefined;
  return c.collection ?? short;
}

/** The methods a collection should expose via XRPC. */
export function getCollectionMethods(cfg: CollectionConfig): CollectionMethod[] {
  return cfg.methods ?? DEFAULT_COLLECTION_METHODS;
}
