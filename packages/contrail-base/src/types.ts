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
      const existing = caps.get(colCfg.collection) ?? 0;
      if (cap > existing) caps.set(colCfg.collection, cap);
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
  /** Full NSID of the record type this collection indexes. */
  collection: string;
  /** Include this collection in Jetstream ingest / discovery (default true).
   *  Set false for dependent collections (auto-fetched on demand). */
  discover?: boolean;
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
  /** When spaces are enabled globally, emit a parallel spaces_records_<short> table
   *  so this collection can also live inside spaces. Defaults to true. */
  allowInSpaces?: boolean;
  /** JSON field on the record used as the canonical event time, parsed and
   *  written into `time_us` during backfill (and clamped to now). Default
   *  `"createdAt"`. Set to `false` to disable parsing and keep ingest time. */
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
  "wss://jetstream1.us-east.bsky.network",
];

/**
 * Shape a configured jetstream list for `@atcute/jetstream`'s `url` option.
 *
 * @atcute distinguishes a string url (one fixed instance) from an array url (a
 * pool of interchangeable instances). For an array it seeds `#lastUsedUrl=''`
 * and rolls the cursor back 10s on the first connect, to absorb clock skew
 * between whichever pooled instances a resumed cursor may have crossed. A string
 * has no such rollback — one instance, no skew.
 *
 * Contrail's cron ingestion rebuilds the subscription every cycle, so for a
 * single-instance config that "first-connect" rollback fires *every* cycle and
 * redundantly re-ingests the last 10s. Collapsing a one-element pool to a string
 * opts out of a safety margin that single-instance topology never needs; a real
 * pool (2+) is left as an array so the cross-instance rollback is preserved.
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

export interface ContrailConfig {
  namespace: string;
  /** Collections to index, keyed by short name. Short names become endpoint URL segments
   *  (`<namespace>.<short>.listRecords`) and table suffixes (`records_<short>`). */
  collections: Record<string, CollectionConfig>;
  profiles?: (string | ProfileConfig)[];
  relays?: string[];
  jetstreams?: string[];
  feeds?: Record<string, FeedConfig>;
  logger?: Logger;
  /** Expose the notifyOfUpdate HTTP endpoint. Off by default.
   *  Set to `true` for open access, or a string to require `Authorization: Bearer <secret>`. */
  notify?: boolean | string;
  /** Permissioned spaces configuration. When set, the service exposes space XRPCs. */
  spaces?: import("./spaces/types").SpacesConfig;
  /** Community module configuration. Typed by the community package via
   *  declaration merging — contrail core only knows it's "something the
   *  community package consumes." Set when wiring community via
   *  `createCommunityIntegration({ ... })`. Requires `spaces.authority`. */
  community?: unknown;
  /** Realtime module configuration. When set, the service exposes ticket + SSE/WS
   *  subscribe XRPCs, and wraps the spaces adapter to publish events after writes. */
  realtime?: import("./realtime/types").RealtimeConfig;
  /** Write-only, post-commit observers of applied records — derived indexes,
   *  audit logs, webhook fan-outs. Each fires after every `applyEvents()` commit
   *  on BOTH the live and backfill paths, with failures isolated so a throwing
   *  sink never blocks ingestion. Distinct from `realtime`, which serves live
   *  subscribers over a lossy delivery channel and is intentionally silent during
   *  backfill. Public records only. */
  sinks?: import("./sinks/types").Sink[];
  /** Labels module configuration. When set, contrail subscribes to the
   *  configured labelers, indexes their labels into a single `labels` table,
   *  and hydrates `record.labels` onto `listRecords` / `getRecord` / profile
   *  responses gated by the caller's `atproto-accept-labelers` header. */
  labels?: import("./labels/types").LabelsConfig;
  /** Customize the auto-generated `<namespace>.authFull` lexicon. */
  permissionSet?: PermissionSetConfig;
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
     *  alternative DID method composition.
     *  Mirrors the `AuthorityConfig.resolver` pattern in `spaces/types.ts`. */
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

/** Single entry in an atproto permission-set's `permissions` array.
 *  See https://atproto.com/guides/permission-sets for the full schema. */
export type PermissionEntry =
  | { type: "permission"; resource: "rpc"; lxm?: string[]; aud?: string; inheritAud?: boolean }
  | { type: "permission"; resource: "repo"; collection?: string[] }
  | { type: "permission"; resource: "blob"; accept?: string[]; maxSize?: number }
  | { type: "permission"; resource: "account"; attr?: string[] }
  | { type: "permission"; resource: string; [key: string]: unknown };

export interface PermissionSetConfig {
  /** Shown on the OAuth consent screen. Defaults to the namespace. */
  title?: string;
  /** Shown on the OAuth consent screen. Defaults to a generated description. */
  description?: string;
  /** Extra permission entries appended after the auto-generated rpc entry —
   *  e.g. repo writes for collections your app needs the user to create, or
   *  blob permissions for uploads. */
  additional?: PermissionEntry[];
}

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
  const profiles = (config.profiles ?? DEFAULT_PROFILES).map(
    normalizeProfileConfig
  );
  const collections: Record<string, CollectionConfig> = {};

  // Default `discover: false` for any collection whose NSID lives under the
  // `app.bsky.*` namespace, since these are external/network-wide records that
  // would otherwise blow up storage if left discoverable.
  for (const [short, c] of Object.entries(config.collections)) {
    collections[short] =
      c.discover === undefined &&
      typeof c.collection === "string" &&
      c.collection.startsWith("app.bsky.")
        ? { ...c, discover: false }
        : c;
  }

  for (const p of profiles) {
    const short = p.shortName!;
    if (!collections[short]) {
      collections[short] = { collection: p.collection, discover: false };
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
    nsidToShort[colConfig.collection] = short;

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
  /** Set when the row originates from a per-space table. Used by the
   *  pipeline/hydration/response layers to route child queries to the same
   *  space and tag the output. */
  space?: string;
}

export interface IngestEvent {
  uri: string;
  did: string;
  collection: string; // full NSID
  rkey: string;
  operation: "create" | "update" | "delete";
  cid: string | null;
  record: string | null;
  time_us: number;
  indexed_at: number;
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

export function validateConfig(config: ContrailConfig): void {
  const shortNames = new Set<string>();
  for (const [short, colConfig] of Object.entries(config.collections)) {
    validateShortName(short);
    if (shortNames.has(short)) {
      throw new Error(`Duplicate collection short name: ${short}`);
    }
    shortNames.add(short);

    if (!colConfig.collection) {
      throw new Error(`Collection "${short}" is missing required 'collection' field (NSID)`);
    }

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

  if (config.community && !config.spaces?.authority) {
    throw new Error(
      "Invalid config: `community` requires `spaces.authority`. Community-owned spaces reuse the spaces storage adapter."
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

/** Table name for a collection's records inside spaces. */
export function spacesRecordsTableName(shortName: string): string {
  return "spaces_records_" + sanitizeIdentifier(shortName);
}

/** All collection short names. */
export function getCollectionShortNames(config: ContrailConfig): string[] {
  return Object.keys(config.collections);
}

/** Alias: collection short names (same as getCollectionShortNames). */
export const getCollectionNames = getCollectionShortNames;

/** All indexed record NSIDs (what Jetstream filters on). */
export function getCollectionNsids(config: ContrailConfig): string[] {
  return Object.values(config.collections).map((c) => c.collection);
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
  return Object.values(config.collections)
    .filter((c) => c.discover !== false)
    .map((c) => c.collection);
}

export function getDependentNsids(config: ContrailConfig): string[] {
  return Object.values(config.collections)
    .filter((c) => c.discover === false)
    .map((c) => c.collection);
}

/** Short name for a record NSID, if known. */
export function shortNameForNsid(
  config: ContrailConfig,
  nsid: string
): string | undefined {
  const resolved = (config as ResolvedContrailConfig)._resolved;
  if (resolved?.nsidToShort) return resolved.nsidToShort[nsid];
  for (const [short, c] of Object.entries(config.collections)) {
    if (c.collection === nsid) return short;
  }
  return undefined;
}

/** Full NSID for a collection short name. */
export function nsidForShortName(
  config: ContrailConfig,
  short: string
): string | undefined {
  return config.collections[short]?.collection;
}

/** The methods a collection should expose via XRPC. */
export function getCollectionMethods(cfg: CollectionConfig): CollectionMethod[] {
  return cfg.methods ?? DEFAULT_COLLECTION_METHODS;
}
