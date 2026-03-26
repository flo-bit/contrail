import type { ContrailConfig, Database, ResolvedContrailConfig, ResolvedMaps } from "../types";
import type { SqlDialect } from "../dialect";
import { buildFtsSchema, getDialect } from "../dialect";
import { getRelationField, countColumnName, recordsTableName, resolveConfig } from "../types";
import { getSearchableFields } from "../search";

function getResolved(config: ContrailConfig): ResolvedMaps {
  return (config as ResolvedContrailConfig)._resolved ?? resolveConfig(config)._resolved;
}

function buildBaseSchema(dialect: SqlDialect): string {
  return `
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
  time_us ${dialect.bigintType} NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  did TEXT PRIMARY KEY,
  handle TEXT,
  pds TEXT,
  resolved_at ${dialect.bigintType} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_handle ON identities(handle);
`;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

function buildCollectionTables(config: ContrailConfig, dialect: SqlDialect): string[] {
  const stmts: string[] = [];
  for (const collection of Object.keys(config.collections)) {
    const table = recordsTableName(collection);
    stmts.push(
      `CREATE TABLE IF NOT EXISTS ${table} (
        uri TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        cid TEXT,
        record ${dialect.recordColumnType},
        time_us ${dialect.bigintType} NOT NULL,
        indexed_at ${dialect.bigintType} NOT NULL
      )`
    );
    stmts.push(`CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_did ON ${table}(did)`);
    stmts.push(`CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_time ON ${table}(time_us DESC)`);
  }
  return stmts;
}

function buildDynamicIndexes(config: ContrailConfig, dialect: SqlDialect): string[] {
  const resolved = getResolved(config);
  const indexes: string[] = [];
  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const table = recordsTableName(collection);
    const queryable = resolved.queryable[collection] ?? colConfig.queryable ?? {};
    for (const field of Object.keys(queryable)) {
      const idxName = `idx_${sanitizeName(collection)}_${sanitizeName(field)}`;
      indexes.push(
        `CREATE INDEX IF NOT EXISTS ${idxName} ON ${table}(${dialect.indexExpression(dialect.jsonExtract('record', field))})`
      );
    }

    // Relation field indexes go on the CHILD collection's table
    for (const [, rel] of Object.entries(colConfig.relations ?? {})) {
      const on = getRelationField(rel);
      const childTable = recordsTableName(rel.collection);
      const idxName = `idx_${sanitizeName(rel.collection)}_${sanitizeName(on)}`;
      indexes.push(
        `CREATE INDEX IF NOT EXISTS ${idxName} ON ${childTable}(${dialect.indexExpression(dialect.jsonExtract('record', on))})`
      );
    }
  }
  return indexes;
}

function buildCountColumns(config: ContrailConfig): string[] {
  const resolved = getResolved(config);
  const stmts: string[] = [];
  const addedColumns = new Map<string, Set<string>>(); // table → columns

  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const table = recordsTableName(collection);
    const relMap = resolved.relations[collection] ?? {};

    if (!addedColumns.has(table)) addedColumns.set(table, new Set());
    const tableColumns = addedColumns.get(table)!;

    for (const [relName, rel] of Object.entries(colConfig.relations ?? {})) {
      if (rel.count === false) continue;
      // Total count column — on the PARENT collection's table
      const totalCol = countColumnName(rel.collection);
      if (!tableColumns.has(totalCol)) {
        tableColumns.add(totalCol);
        stmts.push(
          `ALTER TABLE ${table} ADD COLUMN ${totalCol} INTEGER NOT NULL DEFAULT 0`
        );
      }
      stmts.push(
        `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_${totalCol} ON ${table}(${totalCol} DESC, time_us DESC)`
      );

      // Grouped count columns
      const mapping = relMap[relName];
      if (mapping) {
        for (const [, fullToken] of Object.entries(mapping.groups)) {
          const groupCol = countColumnName(fullToken);
          if (!tableColumns.has(groupCol)) {
            tableColumns.add(groupCol);
            stmts.push(
              `ALTER TABLE ${table} ADD COLUMN ${groupCol} INTEGER NOT NULL DEFAULT 0`
            );
          }
          stmts.push(
            `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_${groupCol} ON ${table}(${groupCol} DESC, time_us DESC)`
          );
        }
      }
    }
  }
  return stmts;
}

function buildFeedTables(config: ContrailConfig, dialect: SqlDialect): string[] {
  if (!config.feeds || Object.keys(config.feeds).length === 0) return [];
  const stmts = [
    `CREATE TABLE IF NOT EXISTS feed_items (
      actor TEXT NOT NULL,
      uri TEXT NOT NULL,
      collection TEXT NOT NULL,
      time_us ${dialect.bigintType} NOT NULL,
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
    const table = recordsTableName(col);
    const safe = sanitizeName(col);
    stmts.push(
      `CREATE INDEX IF NOT EXISTS idx_${safe}_subject ON ${table}(${dialect.indexExpression(dialect.jsonExtract('record', 'subject'))})`
    );
  }

  return stmts;
}

function buildFtsTables(config: ContrailConfig, dialect: SqlDialect): string[] {
  const stmts: string[] = [];
  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const fields = getSearchableFields(collection, colConfig);
    if (!fields || fields.length === 0) continue;
    const table = recordsTableName(collection);
    stmts.push(...buildFtsSchema(dialect, table, fields));
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
  const dialect = getDialect(db);
  const baseStatements = buildBaseSchema(dialect).split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const collectionStatements = buildCollectionTables(config, dialect);
  const indexStatements = buildDynamicIndexes(config, dialect);
  const ftsStatements = buildFtsTables(config, dialect);
  const feedStatements = buildFeedTables(config, dialect);
  const all = [...baseStatements, ...collectionStatements, ...indexStatements, ...ftsStatements, ...feedStatements];

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
