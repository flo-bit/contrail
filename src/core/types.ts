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
  follow: string;
  targets: string[];
  /** Max feed items per user (default: 200). Oldest items are pruned after backfill. */
  maxItems?: number;
}

export const DEFAULT_FEED_MAX_ITEMS = 200;

export interface CollectionConfig {
  discover?: boolean;
  queryable?: Record<string, QueryableField>;
  relations?: Record<string, RelationConfig>;
  /** Forward references: fields on this collection's records that point at another collection. */
  references?: Record<string, ReferenceConfig>;
  queries?: Record<string, CustomQueryHandler>;
  pipelineQueries?: Record<string, PipelineQueryHandler>;
  /** FTS5 search fields. Provide an array of field names to enable full-text search. Omit or set to false to disable. */
  searchable?: string[] | false;
}

export interface ProfileConfig {
  collection: string;
  rkey?: string; // defaults to "self"
}

export const DEFAULT_PROFILES: ProfileConfig[] = [
  { collection: "app.bsky.actor.profile" },
];

/** Normalize a profiles config entry (string or object) into ProfileConfig. */
export function normalizeProfileConfig(
  p: string | ProfileConfig
): ProfileConfig {
  return typeof p === "string" ? { collection: p } : p;
}

export const DEFAULT_JETSTREAMS = [
  "wss://jetstream1.us-east.bsky.network",
  "wss://jetstream2.us-east.bsky.network",
  "wss://jetstream1.us-west.bsky.network",
  "wss://jetstream2.us-west.bsky.network",
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
  collections: Record<string, CollectionConfig>;
  profiles?: (string | ProfileConfig)[];
  relays?: string[];
  jetstreams?: string[];
  feeds?: Record<string, FeedConfig>;
  logger?: Logger;
  /** Expose the notifyOfUpdate HTTP endpoint. Off by default.
   *  Set to `true` for open access, or a string to require `Authorization: Bearer <secret>`. */
  notify?: boolean | string;
}

export interface ResolvedRelation {
  collection: string;
  groupBy: string;
  groups: Record<string, string>; // shortName → full token value
}

export interface ResolvedMaps {
  queryable: Record<string, Record<string, QueryableField>>;
  relations: Record<string, Record<string, ResolvedRelation>>;
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
    if (!collections[p.collection]) {
      collections[p.collection] = { discover: false };
    }
  }

  // Auto-add follow collections from feed configs as dependent collections
  if (config.feeds) {
    for (const feed of Object.values(config.feeds)) {
      if (!collections[feed.follow]) {
        collections[feed.follow] = { discover: false };
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

  for (const [collection, colConfig] of Object.entries(config.collections)) {
    if (colConfig.queryable) {
      queryable[collection] = colConfig.queryable;
    }

    if (colConfig.relations) {
      for (const [relName, rel] of Object.entries(colConfig.relations)) {
        if (!rel.groupBy) continue;
        const groups: Record<string, string> = rel.groups ? { ...rel.groups } : {};
        if (Object.keys(groups).length > 0) {
          if (!relations[collection]) relations[collection] = {};
          relations[collection][relName] = {
            collection: rel.collection,
            groupBy: rel.groupBy,
            groups,
          };
        }
      }
    }
  }

  return { queryable, relations };
}

export function getFeedFollowCollections(config: ContrailConfig): string[] {
  if (!config.feeds) return [];
  return [...new Set(Object.values(config.feeds).map((f) => f.follow))];
}

// Record types

export interface RecordRow {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  cid: string | null;
  record: string | null;
  time_us: number;
  indexed_at: number;
}

export interface IngestEvent {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  operation: "create" | "update" | "delete";
  cid: string | null;
  record: string | null;
  time_us: number;
  indexed_at: number;
}

// Validation

const SAFE_FIELD_NAME = /^[a-zA-Z0-9_.]+$/;

export function validateFieldName(field: string): string {
  if (!SAFE_FIELD_NAME.test(field)) {
    throw new Error(`Invalid field name: ${field}`);
  }
  return field;
}

export function validateConfig(config: ContrailConfig): void {
  for (const [collection, colConfig] of Object.entries(config.collections)) {
    for (const field of Object.keys(colConfig.queryable ?? {})) {
      validateFieldName(field);
    }
    for (const [, rel] of Object.entries(colConfig.relations ?? {})) {
      if (rel.field) validateFieldName(rel.field);
      if (rel.groupBy) validateFieldName(rel.groupBy);
      if (rel.countDistinct) validateFieldName(rel.countDistinct);
    }
    if (Array.isArray(colConfig.searchable)) {
      for (const field of colConfig.searchable) {
        validateFieldName(field);
      }
    }
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

export function countColumnName(type: string): string {
  return "count_" + type.replace(/[^a-zA-Z0-9]/g, "_");
}

export function recordsTableName(collection: string): string {
  return "records_" + collection.replace(/[^a-zA-Z0-9]/g, "_");
}

export function getCollectionNames(config: ContrailConfig): string[] {
  return Object.keys(config.collections);
}

export function getDependentCollections(config: ContrailConfig): string[] {
  return Object.entries(config.collections)
    .filter(([, c]) => c.discover === false)
    .map(([name]) => name);
}

export function getDiscoverableCollections(config: ContrailConfig): string[] {
  return Object.entries(config.collections)
    .filter(([, c]) => c.discover !== false)
    .map(([name]) => name);
}
