// Database interface — D1 implements this natively
export interface Database {
  prepare(sql: string): Statement;
  batch(stmts: Statement[]): Promise<any[]>;
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

export interface CollectionConfig {
  discover?: boolean;
  queryable?: Record<string, QueryableField>;
  relations?: Record<string, RelationConfig>;
  /** Forward references: fields on this collection's records that point at another collection. */
  references?: Record<string, ReferenceConfig>;
  queries?: Record<string, CustomQueryHandler>;
  /** FTS5 search fields. string[] = explicit fields, false = disabled, omitted = auto-detect non-range queryable fields */
  searchable?: string[] | false;
}

export const DEFAULT_PROFILES = ["app.bsky.actor.profile"];

export const DEFAULT_JETSTREAMS = [
  "wss://jetstream1.us-east.bsky.network",
  "wss://jetstream2.us-east.bsky.network",
  "wss://jetstream1.us-west.bsky.network",
  "wss://jetstream2.us-west.bsky.network",
];

export const DEFAULT_RELAYS = [
  "https://relay1.us-east.bsky.network"
];

export interface ContrailConfig {
  namespace: string;
  collections: Record<string, CollectionConfig>;
  profiles?: string[];
  relays?: string[];
  jetstreams?: string[];
}

/**
 * Resolve config: apply defaults and auto-add profile collections.
 */
export function resolveConfig(config: ContrailConfig): ContrailConfig {
  const profiles = config.profiles ?? DEFAULT_PROFILES;
  const collections = { ...config.collections };
  for (const col of profiles) {
    if (!collections[col]) {
      collections[col] = { discover: false };
    }
  }

  return {
    ...config,
    collections,
    profiles,
    jetstreams: config.jetstreams ?? DEFAULT_JETSTREAMS,
    relays: config.relays ?? DEFAULT_RELAYS,
  };
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
