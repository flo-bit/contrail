import type {
  ContrailConfig,
  Database,
  ResolvedContrailConfig,
  Statement,
  ResolvedMaps,
} from "../types";
import type { SqlDialect } from "../dialect";
import {
  buildFtsSchema,
  getDialect,
  postgresDialect,
  sqliteFtsContentExpression,
} from "../dialect";
import {
  countColumnName,
  getRelationField,
  groupedCountColumnName,
  recordsTableName,
  resolveConfig,
} from "../types";
import {
  ftsRowTableName,
  ftsTableName,
  getSearchableFields,
} from "../search";
import { buildLabelsSchema } from "../labels/schema";
import {
  assertFreshChangeLogGeneration,
  buildChangeLogSchema,
  initializeChangeLog,
  probeChangeLogSchema,
} from "../change-log";
import {
  canonicalChangeDefinitions,
  changesEnabled,
} from "../types";
import { getMeta, setMeta } from "./meta";

export const CONTRAIL_SCHEMA_VERSION = 12;
const SCHEMA_FINGERPRINT_KEY = "schema_fingerprint";

function getResolved(config: ContrailConfig): ResolvedMaps {
  return (
    (config as ResolvedContrailConfig)._resolved ?? resolveConfig(config)._resolved
  );
}

function buildBaseSchema(dialect: SqlDialect): string {
  return `
CREATE TABLE IF NOT EXISTS _contrail_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backfills (
  did TEXT NOT NULL,
  collection TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  pds_cursor TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at ${dialect.bigintType},
  next_retry_at ${dialect.bigintType},
  scheduled_retries INTEGER NOT NULL DEFAULT 0,
  retry_exhausted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (did, collection)
);
CREATE TABLE IF NOT EXISTS discovery (
  collection TEXT NOT NULL,
  relay TEXT NOT NULL,
  cursor TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at ${dialect.bigintType},
  next_retry_at ${dialect.bigintType},
  PRIMARY KEY (collection, relay)
);
CREATE TABLE IF NOT EXISTS cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  time_us ${dialect.bigintType} NOT NULL
);
CREATE TABLE IF NOT EXISTS source_position (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source TEXT NOT NULL,
  epoch TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at ${dialect.bigintType} NOT NULL
);
CREATE TABLE IF NOT EXISTS backfill_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_id TEXT,
  started_at ${dialect.bigintType},
  heartbeat_at ${dialect.bigintType},
  finished_at ${dialect.bigintType}
);
CREATE TABLE IF NOT EXISTS bootstrap_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL CHECK (phase IN ('snapshot', 'catchup', 'complete')),
  snapshot_json TEXT NOT NULL,
  capture_source TEXT NOT NULL,
  capture_epoch TEXT NOT NULL,
  capture_cursor TEXT NOT NULL,
  snapshot_complete INTEGER NOT NULL DEFAULT 0,
  catchup_source TEXT,
  catchup_epoch TEXT,
  catchup_cursor TEXT,
  change_source TEXT,
  change_epoch TEXT,
  change_cursor TEXT,
  started_at ${dialect.bigintType} NOT NULL,
  updated_at ${dialect.bigintType} NOT NULL,
  finished_at ${dialect.bigintType}
);
CREATE TABLE IF NOT EXISTS bootstrap_snapshot_progress (
  bootstrap_id INTEGER NOT NULL,
  partition TEXT NOT NULL,
  cursor TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at ${dialect.bigintType} NOT NULL,
  PRIMARY KEY (bootstrap_id, partition),
  FOREIGN KEY (bootstrap_id) REFERENCES bootstrap_state(id)
);
CREATE TABLE IF NOT EXISTS identities (
  did TEXT PRIMARY KEY,
  handle TEXT,
  pds TEXT,
  resolved_at ${dialect.bigintType} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_handle ON identities(handle);
CREATE TABLE IF NOT EXISTS record_versions (
  uri TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  cid TEXT,
  source_id TEXT NOT NULL,
  source_epoch TEXT,
  source_revision TEXT,
  source_time_us ${dialect.bigintType} NOT NULL,
  source_cursor TEXT,
  indexed_at ${dialect.bigintType} NOT NULL,
  projection_token TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_record_versions_collection ON record_versions(collection);
CREATE INDEX IF NOT EXISTS idx_record_versions_did ON record_versions(did);
CREATE INDEX IF NOT EXISTS idx_record_versions_tombstones ON record_versions(operation, indexed_at);
CREATE TABLE IF NOT EXISTS ingest_diagnostics (
  category TEXT PRIMARY KEY,
  total ${dialect.bigintType} NOT NULL,
  last_seen_at ${dialect.bigintType} NOT NULL
);
CREATE TABLE IF NOT EXISTS _contrail_projection_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision ${dialect.bigintType} NOT NULL DEFAULT 0,
  guard INTEGER NOT NULL DEFAULT 1
    CONSTRAINT projection_guard_valid CHECK (guard = 1)
);
`;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

export function buildCollectionTables(
  config: ContrailConfig,
  dialect: SqlDialect,
): string[] {
  const statements: string[] = [];
  for (const shortName of Object.keys(config.collections)) {
    const table = recordsTableName(shortName);
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${table} (
        uri TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        cid TEXT,
        record ${dialect.recordColumnType},
        time_us ${dialect.bigintType} NOT NULL,
        indexed_at ${dialect.bigintType} NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(shortName)}_did ON ${table}(did)`,
      `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(shortName)}_time ON ${table}(time_us DESC)`,
    );
  }
  return statements;
}

export function buildDynamicIndexes(
  config: ContrailConfig,
  dialect: SqlDialect,
): string[] {
  const resolved = getResolved(config);
  const indexes: string[] = [];
  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const table = recordsTableName(collection);
    const queryable =
      resolved.queryable[collection] ?? colConfig.queryable ?? {};
    for (const field of Object.keys(queryable)) {
      indexes.push(
        `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_${sanitizeName(field)} ON ${table}(${dialect.indexExpression(dialect.jsonExtract("record", field))})`,
      );
    }

    for (const relation of Object.values(colConfig.relations ?? {})) {
      const on = getRelationField(relation);
      const childTable = recordsTableName(relation.collection);
      indexes.push(
        `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(relation.collection)}_${sanitizeName(on)} ON ${childTable}(${dialect.indexExpression(dialect.jsonExtract("record", on))})`,
      );
    }
  }
  return indexes;
}

export function buildCountColumns(config: ContrailConfig): string[] {
  const resolved = getResolved(config);
  const statements: string[] = [];
  const addedColumns = new Map<string, Set<string>>();

  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const table = recordsTableName(collection);
    const relationMap = resolved.relations[collection] ?? {};
    const tableColumns = addedColumns.get(table) ?? new Set<string>();
    addedColumns.set(table, tableColumns);

    for (const [relationName, relation] of Object.entries(
      colConfig.relations ?? {},
    )) {
      if (relation.count === false) continue;
      const totalColumn = countColumnName(relation.collection);
      if (!tableColumns.has(totalColumn)) {
        tableColumns.add(totalColumn);
        statements.push(
          `ALTER TABLE ${table} ADD COLUMN ${totalColumn} INTEGER NOT NULL DEFAULT 0`,
        );
      }
      statements.push(
        `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_${totalColumn} ON ${table}(${totalColumn} DESC, time_us DESC)`,
      );

      const mapping = relationMap[relationName];
      if (!mapping) continue;
      for (const groupKey of Object.keys(mapping.groups)) {
        const groupColumn = groupedCountColumnName(
          relation.collection,
          groupKey,
        );
        if (!tableColumns.has(groupColumn)) {
          tableColumns.add(groupColumn);
          statements.push(
            `ALTER TABLE ${table} ADD COLUMN ${groupColumn} INTEGER NOT NULL DEFAULT 0`,
          );
        }
        statements.push(
          `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_${groupColumn} ON ${table}(${groupColumn} DESC, time_us DESC)`,
        );
      }
    }
  }
  return statements;
}

export async function addColumnIfNotExists(
  db: Database,
  table: string,
  column: string,
  columnDef: string,
): Promise<void> {
  if (getDialect(db) === postgresDialect) {
    await db
      .prepare(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${columnDef}`,
      )
      .run();
    return;
  }

  const info = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  if (info.results.some((candidate) => candidate.name === column)) return;
  try {
    await db
      .prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`)
      .run();
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
}

function isDuplicateColumnError(error: unknown): boolean {
  return (
    error instanceof Error && /duplicate column name/i.test(error.message)
  );
}
function isConcurrentCreateError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "42P07" || code === "42P06") return true;
  if (code !== "23505") return false;
  const constraint = (error as { constraint?: unknown }).constraint;
  return (
    constraint === "pg_type_typname_nsp_index" ||
    constraint === "pg_class_relname_nsp_index" ||
    constraint === "pg_namespace_nspname_index"
  );
}

async function runIdempotentDdl(db: Database, statement: string): Promise<void> {
  try {
    await db.prepare(statement).run();
  } catch (error) {
    if (!isConcurrentCreateError(error)) throw error;
  }
}

export async function applyCountColumns(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  for (const statement of buildCountColumns(config)) {
    const match = statement.match(
      /^ALTER TABLE\s+(\S+)\s+ADD COLUMN\s+(\S+)\s+(.+)$/i,
    );
    if (match) {
      const [, table, column, columnDef] = match;
      await addColumnIfNotExists(db, table, column, columnDef);
    } else {
      await db.prepare(statement).run();
    }
  }
}

function buildFeedTables(config: ContrailConfig, dialect: SqlDialect): string[] {
  if (!config.feeds || Object.keys(config.feeds).length === 0) return [];
  const statements = [
    `CREATE TABLE IF NOT EXISTS feed_items (
      actor TEXT NOT NULL,
      uri TEXT NOT NULL,
      collection TEXT NOT NULL,
      time_us ${dialect.bigintType} NOT NULL,
      PRIMARY KEY (actor, uri)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_feed_actor_coll_time ON feed_items(actor, collection, time_us DESC)",
    "CREATE INDEX IF NOT EXISTS idx_feed_actor_time ON feed_items(actor, time_us DESC)",
    `CREATE TABLE IF NOT EXISTS feed_prune_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      actor TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS feed_backfills (
      actor TEXT NOT NULL,
      feed TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      retries INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      started_at ${dialect.bigintType},
      PRIMARY KEY (actor, feed)
    )`,
  ];

  const followCollections = new Set(
    Object.values(config.feeds).map((feed) => feed.follow ?? "follow"),
  );
  for (const collection of followCollections) {
    statements.push(
      `CREATE INDEX IF NOT EXISTS idx_${sanitizeName(collection)}_subject ON ${recordsTableName(collection)}(${dialect.indexExpression(dialect.jsonExtract("record", "subject"))})`,
    );
  }
  return statements;
}

export function buildFtsTables(
  config: ContrailConfig,
  dialect: SqlDialect,
): string[] {
  const statements: string[] = [];
  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const fields = getSearchableFields(collection, colConfig);
    if (!fields || fields.length === 0) continue;
    statements.push(
      ...buildFtsSchema(dialect, recordsTableName(collection), fields),
    );
  }
  return statements;
}

async function virtualFtsColumns(
  db: Database,
  table: string,
): Promise<string[]> {
  const rows = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  return (rows.results ?? []).map((row) => row.name);
}

function populateVirtualFtsStatements(
  db: Database,
  collection: string,
  fields: string[],
): Statement[] {
  const recordsTable = recordsTableName(collection);
  const ftsTable = ftsTableName(collection);
  const rowsTable = ftsRowTableName(collection);
  const content = sqliteFtsContentExpression(fields);
  return [
    db.prepare(
      `INSERT INTO ${rowsTable} (uri)
       SELECT uri FROM (
         SELECT uri, ${content} AS content FROM ${recordsTable}
       ) rebuilt
       WHERE content <> ''
       ORDER BY uri`,
    ),
    db.prepare(
      `INSERT INTO ${ftsTable} (rowid, content)
       SELECT fts_rows.id, rebuilt.content
       FROM (
         SELECT uri, ${content} AS content FROM ${recordsTable}
       ) rebuilt
       JOIN ${rowsTable} fts_rows ON fts_rows.uri = rebuilt.uri
       WHERE rebuilt.content <> ''`,
    ),
  ];
}

async function verifyVirtualFtsProjection(
  db: Database,
  collection: string,
  fields: string[],
): Promise<void> {
  const recordsTable = recordsTableName(collection);
  const ftsTable = ftsTableName(collection);
  const rowsTable = ftsRowTableName(collection);
  const content = sqliteFtsContentExpression(fields);
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM (
            SELECT uri, ${content} AS content FROM ${recordsTable}
          ) expected WHERE content <> '') AS expected_rows,
         (SELECT COUNT(*) FROM ${rowsTable}) AS mapping_rows,
         (SELECT COUNT(*) FROM ${ftsTable}) AS fts_rows,
         (SELECT COUNT(*)
            FROM ${rowsTable} mapped
            JOIN ${ftsTable} fts ON fts.rowid = mapped.id
            JOIN (
              SELECT uri FROM (
                SELECT uri, ${content} AS content FROM ${recordsTable}
              ) searchable
              WHERE content <> ''
            ) expected ON expected.uri = mapped.uri) AS joined_rows`,
    )
    .first<{
      expected_rows: number | string;
      mapping_rows: number | string;
      fts_rows: number | string;
      joined_rows: number | string;
    }>();
  const expected = Number(row?.expected_rows ?? 0);
  const mapping = Number(row?.mapping_rows ?? 0);
  const fts = Number(row?.fts_rows ?? 0);
  const joined = Number(row?.joined_rows ?? 0);
  if (mapping !== expected || fts !== expected || joined !== expected) {
    throw new Error(
      `FTS migration verification failed for ${collection}: ` +
        `expected=${expected}, mapping=${mapping}, fts=${fts}, joined=${joined}`,
    );
  }
}

async function migrateLegacyVirtualFts(
  db: Database,
  config: ContrailConfig,
  dialect: SqlDialect,
  collection: string,
  fields: string[],
): Promise<void> {
  const recordsTable = recordsTableName(collection);
  const ftsTable = ftsTableName(collection);
  const rowsTable = ftsRowTableName(collection);
  const schema = buildFtsSchema(dialect, recordsTable, fields);
  await db.batch([
    db.prepare(`DROP TABLE IF EXISTS ${ftsTable}`),
    db.prepare(`DROP TABLE IF EXISTS ${rowsTable}`),
    ...schema.map((statement) => db.prepare(statement)),
    ...populateVirtualFtsStatements(db, collection, fields),
  ]);
  await verifyVirtualFtsProjection(db, collection, fields);
  (config.logger ?? console).log(
    `[schema] migrated ${ftsTable} to indexed rowid maintenance`,
  );
}

async function rebuildVirtualFtsProjection(
  db: Database,
  collection: string,
  fields: string[],
): Promise<void> {
  const ftsTable = ftsTableName(collection);
  const rowsTable = ftsRowTableName(collection);
  await db.batch([
    db.prepare(`DELETE FROM ${ftsTable}`),
    db.prepare(`DELETE FROM ${rowsTable}`),
    ...populateVirtualFtsStatements(db, collection, fields),
  ]);
  await verifyVirtualFtsProjection(db, collection, fields);
}

async function applyFtsTables(
  db: Database,
  config: ContrailConfig,
  dialect: SqlDialect,
): Promise<void> {
  if (dialect.ftsStrategy === "generated-column") {
    for (const statement of buildFtsTables(config, dialect)) {
      await db.prepare(statement).run();
    }
    return;
  }

  for (const [collection, colConfig] of Object.entries(config.collections)) {
    const fields = getSearchableFields(collection, colConfig);
    if (!fields || fields.length === 0) continue;
    const ftsTable = ftsTableName(collection);
    const columns = await virtualFtsColumns(db, ftsTable);
    if (columns.includes("uri")) {
      await migrateLegacyVirtualFts(
        db,
        config,
        dialect,
        collection,
        fields,
      );
      continue;
    }

    const schema = buildFtsSchema(
      dialect,
      recordsTableName(collection),
      fields,
    );
    await db.prepare(schema[0]!).run();
    try {
      await db.prepare(schema[1]!).run();
    } catch {
      // FTS5 is optional in some SQLite builds. The ordinary mapping table is
      // harmless when the virtual table cannot be created.
    }
    const currentColumns =
      columns.length > 0 ? columns : await virtualFtsColumns(db, ftsTable);
    if (currentColumns.length > 0) {
      // applyFtsTables only runs while the global schema fingerprint is stale.
      // Rebuild even an already content-only table before accepting the new
      // fingerprint: a prior migration may have committed and then failed
      // verification, or the configured searchable fields may have changed.
      await rebuildVirtualFtsProjection(db, collection, fields);
    }
  }
}

interface MigrationOp {
  table: string;
  column: string;
  columnDef: string;
  target?: "feeds";
}

const MIGRATIONS: MigrationOp[] = [
  {
    table: "backfills",
    column: "retries",
    columnDef: "INTEGER NOT NULL DEFAULT 0",
  },
  { table: "backfills", column: "last_error", columnDef: "TEXT" },
  { table: "backfills", column: "last_attempt_at", columnDef: "BIGINT" },
  { table: "backfills", column: "next_retry_at", columnDef: "BIGINT" },
  {
    table: "backfills",
    column: "scheduled_retries",
    columnDef: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "backfills",
    column: "retry_exhausted",
    columnDef: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "record_versions",
    column: "source_epoch",
    columnDef: "TEXT",
  },
  {
    table: "record_versions",
    column: "projection_token",
    columnDef: "TEXT",
  },
  {
    table: "discovery",
    column: "retries",
    columnDef: "INTEGER NOT NULL DEFAULT 0",
  },
  { table: "discovery", column: "last_error", columnDef: "TEXT" },
  { table: "discovery", column: "last_attempt_at", columnDef: "BIGINT" },
  { table: "discovery", column: "next_retry_at", columnDef: "BIGINT" },
  {
    table: "feed_backfills",
    column: "retries",
    columnDef: "INTEGER NOT NULL DEFAULT 0",
    target: "feeds",
  },
  {
    table: "feed_backfills",
    column: "last_error",
    columnDef: "TEXT",
    target: "feeds",
  },
  {
    table: "feed_backfills",
    column: "started_at",
    columnDef: "BIGINT",
    target: "feeds",
  },
];

async function runMigrations(
  db: Database,
  hasFeeds: boolean,
): Promise<void> {
  for (const operation of MIGRATIONS) {
    if (operation.target === "feeds" && !hasFeeds) continue;
    await addColumnIfNotExists(
      db,
      operation.table,
      operation.column,
      operation.columnDef,
    );
  }
}

/** Pluggable schema extension retained for applications with their own tables. */
export type SchemaModule = (db: Database) => Promise<void>;

export interface InitSchemaOptions {
  extraSchemas?: SchemaModule[];
}

/**
 * Upgrade visible rows written before source metadata existed. Their local
 * projection time is the only durable freshness boundary available. Keeping a
 * version row prevents an old relay replay from replacing upgraded data.
 */
async function seedLegacyRecordVersions(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  for (const [shortName, collection] of Object.entries(config.collections)) {
    const table = recordsTableName(shortName);
    await db
      .prepare(
        `INSERT INTO record_versions (uri, did, collection, rkey, operation, cid, source_id, source_epoch, source_revision, source_time_us, source_cursor, indexed_at, projection_token)
         SELECT uri, did, ?, rkey, 'update', cid, 'legacy', NULL, NULL, indexed_at, NULL, indexed_at, uri FROM ${table}
         WHERE 1 = 1 ON CONFLICT(uri) DO NOTHING`,
      )
      .bind(collection.collection)
      .run();
  }
}

function hashStrings(parts: string[]): string {
  const joined = parts.join("\0");
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < joined.length; index++) {
    const code = joined.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x811c9dc5) >>> 0;
  }
  return (
    first.toString(16).padStart(8, "0") +
    second.toString(16).padStart(8, "0")
  );
}
function schemaFingerprint(
  config: ContrailConfig,
  dialect: SqlDialect,
  ddl: {
    base: string[];
    collections: string[];
    indexes: string[];
    feeds: string[];
    fts: string[];
    changes: string[];
  },
): string {
  return hashStrings([
    `v${CONTRAIL_SCHEMA_VERSION}`,
    dialect.bigintType,
    config.labels ? "labels" : "",
    ...ddl.base,
    ...ddl.collections,
    ...ddl.indexes,
    ...ddl.feeds,
    ...ddl.fts,
    ...ddl.changes,
    canonicalChangeDefinitions(config),
    ...buildCountColumns(config),
    ...(config.labels ? buildLabelsSchema(dialect) : []),
    JSON.stringify(MIGRATIONS),
  ]);
}

export async function initSchema(
  db: Database,
  config: ContrailConfig,
  options: InitSchemaOptions = {},
): Promise<void> {
  const dialect = getDialect(db);
  const base = buildBaseSchema(dialect)
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const collections = buildCollectionTables(config, dialect);
  const indexes = buildDynamicIndexes(config, dialect);
  const feeds = buildFeedTables(config, dialect);
  const fts = buildFtsTables(config, dialect);
  const changes = buildChangeLogSchema(config, dialect);
  const fingerprint = schemaFingerprint(config, dialect, {
    base,
    collections,
    indexes,
    feeds,
    fts,
    changes,
  });

  if ((await getMeta(db, SCHEMA_FINGERPRINT_KEY)) === fingerprint) {
    for (const apply of options.extraSchemas ?? []) await apply(db);
    return;
  }

  const priorChangeLog = await probeChangeLogSchema(db);
  if (!changesEnabled(config) && priorChangeLog.exists) {
    throw new Error(
      "Durable change logging cannot be disabled or removed during ordinary initialization",
    );
  }

  for (const statement of [...base, ...collections, ...indexes, ...feeds]) {
    await runIdempotentDdl(db, statement);
  }

  if (config.labels) {
    for (const statement of buildLabelsSchema(dialect)) {
      await runIdempotentDdl(db, statement);
    }
  }

  await applyFtsTables(db, config, dialect);

  const hasFeeds = !!(config.feeds && Object.keys(config.feeds).length > 0);
  await runMigrations(db, hasFeeds);
  await db
    .prepare(
      "UPDATE record_versions SET projection_token = uri WHERE projection_token IS NULL",
    )
    .run();
  await db
    .prepare(
      `INSERT INTO _contrail_projection_state (id, revision, guard)
       VALUES (1, 0, 1) ON CONFLICT(id) DO NOTHING`,
    )
    .run();
  await applyCountColumns(db, config);
  await seedLegacyRecordVersions(db, config);

  if (changesEnabled(config)) {
    const concurrentChangeLog = await probeChangeLogSchema(db);
    if (!priorChangeLog.state && !concurrentChangeLog.state) {
      await assertFreshChangeLogGeneration(db);
    }
    for (const statement of changes) await runIdempotentDdl(db, statement);
    await initializeChangeLog(db, config);
  }

  for (const apply of options.extraSchemas ?? []) await apply(db);
  await setMeta(db, SCHEMA_FINGERPRINT_KEY, fingerprint);
}
