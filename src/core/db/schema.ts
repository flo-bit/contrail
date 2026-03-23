import type { ContrailConfig, Database } from "../types";
import { getRelationField, countColumnName } from "../types";
import { resolvedQueryable, resolvedRelationsMap } from "../queryable.generated";
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

function buildCountColumns(config: ContrailConfig): string[] {
  const stmts: string[] = [];
  const addedColumns = new Set<string>();

  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const relMap = resolvedRelationsMap[collection] ?? {};
    for (const [relName, rel] of Object.entries(colConfig.relations ?? {})) {
      if (rel.count === false) continue;
      // Total count column
      const totalCol = countColumnName(rel.collection);
      if (!addedColumns.has(totalCol)) {
        addedColumns.add(totalCol);
        stmts.push(
          `ALTER TABLE records ADD COLUMN ${totalCol} INTEGER NOT NULL DEFAULT 0`
        );
      }
      // Index for sorting by this count within the parent collection
      stmts.push(
        `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_${totalCol} ON records(collection, ${totalCol} DESC, time_us DESC)`
      );

      // Grouped count columns
      const mapping = relMap[relName];
      if (mapping) {
        for (const [, fullToken] of Object.entries(mapping.groups)) {
          const groupCol = countColumnName(fullToken);
          if (!addedColumns.has(groupCol)) {
            addedColumns.add(groupCol);
            stmts.push(
              `ALTER TABLE records ADD COLUMN ${groupCol} INTEGER NOT NULL DEFAULT 0`
            );
          }
          stmts.push(
            `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_${groupCol} ON records(collection, ${groupCol} DESC, time_us DESC)`
          );
        }
      }
    }
  }
  return stmts;
}

function buildFeedTables(config: ContrailConfig): string[] {
  if (!config.feeds || Object.keys(config.feeds).length === 0) return [];
  const stmts = [
    `CREATE TABLE IF NOT EXISTS feed_items (
      actor TEXT NOT NULL,
      uri TEXT NOT NULL,
      collection TEXT NOT NULL,
      time_us INTEGER NOT NULL,
      PRIMARY KEY (actor, uri)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_actor_coll_time ON feed_items(actor, collection, time_us DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_feed_actor_time ON feed_items(actor, time_us DESC)`,
    `CREATE TABLE IF NOT EXISTS feed_backfills (
      actor TEXT NOT NULL,
      feed TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (actor, feed)
    )`,
  ];

  // Index follow collections on subject for efficient fan-out lookups
  const followCollections = new Set(Object.values(config.feeds).map((f) => f.follow));
  for (const col of followCollections) {
    const safe = col.replace(/[^a-zA-Z0-9]/g, "_");
    stmts.push(
      `CREATE INDEX IF NOT EXISTS idx_${safe}_subject ON records(collection, json_extract(record, '$.subject')) WHERE collection = '${col}'`
    );
  }

  return stmts;
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
  const feedStatements = buildFeedTables(config);
  const all = [...baseStatements, ...indexStatements, ...ftsStatements, ...feedStatements];

  await db.batch(all.map((s) => db.prepare(s)));
  await runMigrations(db);

  // Add count columns (ALTER TABLE — may already exist)
  for (const stmt of buildCountColumns(config)) {
    try {
      await db.prepare(stmt).run();
    } catch {
      // Column/index already exists — ignore
    }
  }
}
