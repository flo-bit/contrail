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

export interface FeedConfig {
  /** Short name of the follow collection. */
  follow: string;
  /** Short names of target collections to fan out to. */
  targets: string[];
  /** Max feed items per user (default: 200). Oldest items are pruned after backfill. */
  maxItems?: number;
}

export const DEFAULT_FEED_MAX_ITEMS = 200;

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
  /** Community module configuration. When set, the service exposes community XRPCs
   *  for managing community-owned spaces and tiered access levels. Requires `spaces`. */
  community?: import("./community/types").CommunityConfig;
  /** Realtime module configuration. When set, the service exposes ticket + SSE/WS
   *  subscribe XRPCs, and wraps the spaces adapter to publish events after writes. */
  realtime?: import("./realtime/types").RealtimeConfig;
  /** Labels module configuration. When set, contrail subscribes to the
   *  configured labelers, indexes their labels into a single `labels` table,
   *  and hydrates `record.labels` onto `listRecords` / `getRecord` / profile
   *  responses gated by the caller's `atproto-accept-labelers` header. */
  labels?: import("./labels/types").LabelsConfig;
  /** Customize the auto-generated `<namespace>.permissionSet` lexicon. */
  permissionSet?: PermissionSetConfig;
}

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
  const collections = { ...config.collections };
  for (const p of profiles) {
    const short = p.shortName!;
    if (!collections[short]) {
      collections[short] = { collection: p.collection, discover: false };
    }
  }

  // Auto-add follow collections from feed configs as dependent collections if they're
  // not already listed. Feed config already uses short names so nothing to resolve —
  // but if the user forgot to declare the follow collection, we can't auto-add it without
  // knowing its NSID. In that case we warn later via validateConfig.

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
  return [...new Set(Object.values(config.feeds).map((f) => f.follow))];
}

/** Alias for getFeedFollowShortNames. */
export const getFeedFollowCollections = getFeedFollowShortNames;

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
      if (!config.collections[feed.follow]) {
        throw new Error(
          `Feed "${feedName}" references unknown follow collection "${feed.follow}"`
        );
      }
      for (const target of feed.targets) {
        if (!config.collections[target]) {
          throw new Error(
            `Feed "${feedName}" references unknown target collection "${target}"`
          );
        }
      }
    }
  }

  if (config.community && !config.spaces) {
    throw new Error(
      "Invalid config: `community` requires `spaces`. Community-owned spaces reuse the spaces storage adapter."
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
