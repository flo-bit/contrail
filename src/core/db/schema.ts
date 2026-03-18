import type { ContrailConfig, Database } from "../types";
import { getRelationField } from "../types";
import { resolvedQueryable } from "../queryable.generated";
import { getSearchableFields, ftsTableName } from "../search";

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  uri TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey TEXT NOT NULL,
  cid TEXT,
  record TEXT,
  time_us INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection_time ON records(collection, time_us DESC);
CREATE INDEX IF NOT EXISTS idx_records_collection_did ON records(collection, did);
CREATE TABLE IF NOT EXISTS counts (
  uri TEXT NOT NULL,
  type TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (uri, type)
);
CREATE TABLE IF NOT EXISTS backfills (
  did TEXT NOT NULL,
  collection TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  pds_cursor TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (did, collection)
);
CREATE TABLE IF NOT EXISTS discovery (
  collection TEXT NOT NULL,
  relay TEXT NOT NULL,
  cursor TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection, relay)
);
CREATE TABLE IF NOT EXISTS cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  time_us INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  did TEXT PRIMARY KEY,
  handle TEXT,
  pds TEXT,
  resolved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_handle ON identities(handle);
`;

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

function buildDynamicIndexes(config: ContrailConfig): string[] {
  const indexes: string[] = [];
  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const queryable = resolvedQueryable[collection] ?? colConfig.queryable ?? {};
    for (const field of Object.keys(queryable)) {
      const idxName = `idx_${sanitizeName(collection)}_${sanitizeName(field)}`;
      indexes.push(
        `CREATE INDEX IF NOT EXISTS ${idxName} ON records(collection, json_extract(record, '$.${field}'))`
      );
    }

    for (const [, rel] of Object.entries(colConfig.relations ?? {})) {
      const on = getRelationField(rel);
      const idxName = `idx_${sanitizeName(rel.collection)}_${sanitizeName(on)}`;
      indexes.push(
        `CREATE INDEX IF NOT EXISTS ${idxName} ON records(collection, json_extract(record, '$.${on}'))`
      );
    }
  }
  return indexes;
}

function buildFtsTables(config: ContrailConfig): string[] {
  const stmts: string[] = [];
  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const fields = getSearchableFields(collection, colConfig);
    if (!fields || fields.length === 0) continue;
    const table = ftsTableName(collection);
    stmts.push(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(uri UNINDEXED, content)`
    );
  }
  return stmts;
}

const MIGRATIONS = [
  "ALTER TABLE backfills ADD COLUMN retries INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE backfills ADD COLUMN last_error TEXT",
];

async function runMigrations(db: Database): Promise<void> {
  for (const sql of MIGRATIONS) {
    try {
      await db.prepare(sql).run();
    } catch {
      // Column already exists — ignore
    }
  }
}

export async function initSchema(
  db: Database,
  config: ContrailConfig
): Promise<void> {
  const baseStatements = BASE_SCHEMA.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const indexStatements = buildDynamicIndexes(config);
  const ftsStatements = buildFtsTables(config);
  const all = [...baseStatements, ...indexStatements, ...ftsStatements];

  await db.batch(all.map((s) => db.prepare(s)));
  await runMigrations(db);
}
