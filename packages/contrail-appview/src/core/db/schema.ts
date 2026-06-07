import type { ContrailConfig, Database, ResolvedContrailConfig, ResolvedMaps } from "../types";
import type { SqlDialect } from "../dialect";
import { buildFtsSchema, getDialect, postgresDialect } from "../dialect";
import {
  getRelationField,
  countColumnName,
  groupedCountColumnName,
  recordsTableName,
  spacesRecordsTableName,
  resolveConfig,
} from "../types";
import { getSearchableFields } from "../search";
import { buildSpacesBaseSchema } from "../spaces/schema";
import { buildLabelsSchema } from "../labels/schema";

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

interface BuilderOpts {
  /** Emit tables for the spaces variant (spaces_records_<short> with space_uri column). */
  forSpaces?: boolean;
}

function tableFor(shortName: string, opts: BuilderOpts): string {
  return opts.forSpaces ? spacesRecordsTableName(shortName) : recordsTableName(shortName);
}

function namePrefix(opts: BuilderOpts): string {
  return opts.forSpaces ? "sp_" : "";
}

export function buildCollectionTables(
  config: ContrailConfig,
  dialect: SqlDialect,
  opts: BuilderOpts = {}
): string[] {
  const stmts: string[] = [];
  for (const [shortName, colConfig] of Object.entries(config.collections)) {
    if (opts.forSpaces && colConfig.allowInSpaces === false) continue;
    const table = tableFor(shortName, opts);
    const np = namePrefix(opts);
    if (opts.forSpaces) {
      stmts.push(
        `CREATE TABLE IF NOT EXISTS ${table} (
          space_uri TEXT NOT NULL,
          uri TEXT NOT NULL,
          did TEXT NOT NULL,
          rkey TEXT NOT NULL,
          cid TEXT,
          record ${dialect.recordColumnType},
          time_us ${dialect.bigintType} NOT NULL,
          indexed_at ${dialect.bigintType} NOT NULL,
          PRIMARY KEY (space_uri, did, rkey)
        )`
      );
      stmts.push(
        `CREATE INDEX IF NOT EXISTS idx_${np}${sanitizeName(shortName)}_space_time ON ${table}(space_uri, time_us DESC)`
      );
      stmts.push(
        `CREATE INDEX IF NOT EXISTS idx_${np}${sanitizeName(shortName)}_space_did ON ${table}(space_uri, did)`
      );
    } else {
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
      stmts.push(`CREATE INDEX IF NOT EXISTS idx_${sanitizeName(shortName)}_did ON ${table}(did)`);
      stmts.push(`CREATE INDEX IF NOT EXISTS idx_${sanitizeName(shortName)}_time ON ${table}(time_us DESC)`);
    }
  }
  return stmts;
}

export function buildDynamicIndexes(
  config: ContrailConfig,
  dialect: SqlDialect,
  opts: BuilderOpts = {}
): string[] {
  const resolved = getResolved(config);
  const indexes: string[] = [];
  const np = namePrefix(opts);
  for (const [collection, colConfig] of Object.entries(config.collections)) {
    if (opts.forSpaces && colConfig.allowInSpaces === false) continue;
    const table = tableFor(collection, opts);
    const queryable = resolved.queryable[collection] ?? colConfig.queryable ?? {};
    for (const field of Object.keys(queryable)) {
      const idxName = `idx_${np}${sanitizeName(collection)}_${sanitizeName(field)}`;
      indexes.push(
        `CREATE INDEX IF NOT EXISTS ${idxName} ON ${table}(${dialect.indexExpression(dialect.jsonExtract('record', field))})`
      );
    }

    for (const [, rel] of Object.entries(colConfig.relations ?? {})) {
      const childShort = rel.collection;
      const childConfig = config.collections[childShort];
      if (opts.forSpaces && childConfig?.allowInSpaces === false) continue;
      const on = getRelationField(rel);
      const childTable = tableFor(childShort, opts);
      const idxName = `idx_${np}${sanitizeName(childShort)}_${sanitizeName(on)}`;
      indexes.push(
        `CREATE INDEX IF NOT EXISTS ${idxName} ON ${childTable}(${dialect.indexExpression(dialect.jsonExtract('record', on))})`
      );
    }
  }
  return indexes;
}

export function buildCountColumns(config: ContrailConfig, opts: BuilderOpts = {}): string[] {
  const resolved = getResolved(config);
  const stmts: string[] = [];
  const addedColumns = new Map<string, Set<string>>();
  const np = namePrefix(opts);

  for (const [collection, colConfig] of Object.entries(config.collections)) {
    if (opts.forSpaces && colConfig.allowInSpaces === false) continue;
    const table = tableFor(collection, opts);
    const relMap = resolved.relations[collection] ?? {};

    if (!addedColumns.has(table)) addedColumns.set(table, new Set());
    const tableColumns = addedColumns.get(table)!;

    for (const [relName, rel] of Object.entries(colConfig.relations ?? {})) {
      if (rel.count === false) continue;
      if (opts.forSpaces && config.collections[rel.collection]?.allowInSpaces === false) continue;
      const totalCol = countColumnName(rel.collection);
      if (!tableColumns.has(totalCol)) {
        tableColumns.add(totalCol);
        stmts.push(
          `ALTER TABLE ${table} ADD COLUMN ${totalCol} INTEGER NOT NULL DEFAULT 0`
        );
      }
      stmts.push(
        `CREATE INDEX IF NOT EXISTS idx_${np}${sanitizeName(collection)}_${totalCol} ON ${table}(${totalCol} DESC, time_us DESC)`
      );

      const mapping = relMap[relName];
      if (mapping) {
        for (const groupKey of Object.keys(mapping.groups)) {
          const groupCol = groupedCountColumnName(rel.collection, groupKey);
          if (!tableColumns.has(groupCol)) {
            tableColumns.add(groupCol);
            stmts.push(
              `ALTER TABLE ${table} ADD COLUMN ${groupCol} INTEGER NOT NULL DEFAULT 0`
            );
          }
          stmts.push(
            `CREATE INDEX IF NOT EXISTS idx_${np}${sanitizeName(collection)}_${groupCol} ON ${table}(${groupCol} DESC, time_us DESC)`
          );
        }
      }
    }
  }
  return stmts;
}

/**
 * Idempotently add a column to a table, surfacing real DDL errors.
 *
 * Postgres supports `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` natively, so we
 * issue that and let any non-duplicate error propagate. SQLite (including
 * `node:sqlite`) does NOT support `IF NOT EXISTS` on `ADD COLUMN`, so we
 * pre-check `PRAGMA table_info` and short-circuit if the column is already
 * there. Because the PRAGMA-check + ALTER pair is not atomic, a concurrent
 * second `initSchema` call can still hit a "duplicate column name" race; we
 * narrowly absorb exactly that error message and re-throw everything else.
 *
 * Net effect: only the duplicate-column case is absorbed. Missing tables,
 * syntax errors, type mismatches, and any other DDL failure will throw.
 *
 * Exported for direct testing of the idempotency contract; callers in
 * `initSchema` use this internally.
 */
export async function addColumnIfNotExists(
  db: Database,
  table: string,
  column: string,
  columnDef: string,
): Promise<void> {
  const dialect = getDialect(db);
  if (dialect === postgresDialect) {
    await db.prepare(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${columnDef}`,
    ).run();
    return;
  }
  // SQLite path: check existence first, then ALTER without IF NOT EXISTS.
  // PRAGMA table_info() does not accept parameter binding, so we rely on the
  // caller to pass a sanitized identifier (all current callers do — table
  // names come from `recordsTableName`/`spacesRecordsTableName` which
  // sanitize, and column names come from `countColumnName` /
  // `groupedCountColumnName` which also sanitize).
  const info = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  if (info.results.some((c) => c.name === column)) return;
  try {
    await db.prepare(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`,
    ).run();
  } catch (err) {
    // Narrow swallow: only the "duplicate column" race between the PRAGMA
    // read and the ALTER is acceptable. Everything else surfaces.
    if (!isDuplicateColumnError(err)) throw err;
  }
}

function isDuplicateColumnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: unknown }).message;
  if (typeof msg !== "string") return false;
  // node:sqlite / better-sqlite3: "duplicate column name: <col>"
  return /duplicate column name/i.test(msg);
}

/**
 * Postgres `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are
 * NOT atomic against concurrent creators: two transactions can both pass the
 * existence check before either has inserted into `pg_class` / `pg_type`. The
 * loser raises 23505 on `pg_type_typname_nsp_index` (the unique index on
 * `(typname, typnamespace)`) or `pg_class_relname_nsp_index`. Pre-existing
 * tables also surface as 42P07 (`duplicate_table`).
 *
 * SQLite serializes DDL globally, so this race never manifests there.
 *
 * The caller is expected to issue idempotent DDL (IF NOT EXISTS); this helper
 * only absorbs the narrow concurrent-create race.
 */
function isConcurrentCreateError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "42P07" || code === "42P06") return true;
  if (code === "23505") {
    const constraint = (err as { constraint?: unknown }).constraint;
    return (
      constraint === "pg_type_typname_nsp_index" ||
      constraint === "pg_class_relname_nsp_index" ||
      constraint === "pg_namespace_nspname_index"
    );
  }
  return false;
}

/**
 * Run a single DDL statement, absorbing only the concurrent-create race that
 * `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` can hit on
 * Postgres when multiple processes init the same schema in parallel. Genuine
 * DDL errors (syntax, type mismatch, missing column) surface unchanged.
 */
async function runIdempotentDdl(db: Database, stmt: string): Promise<void> {
  try {
    await db.prepare(stmt).run();
  } catch (err) {
    if (!isConcurrentCreateError(err)) throw err;
  }
}

/**
 * Apply the ALTER+INDEX statements emitted by `buildCountColumns`
 * idempotently and without swallowing non-duplicate errors.
 *
 * `buildCountColumns` mixes two statement shapes: `ALTER TABLE ... ADD COLUMN
 *  ...` (not idempotent on SQLite without a pre-check; supports IF NOT EXISTS
 *  on Postgres) and `CREATE INDEX IF NOT EXISTS ...` (idempotent on both
 *  dialects). We route ALTERs through `addColumnIfNotExists` and run indexes
 *  directly.
 */
export async function applyCountColumns(
  db: Database,
  config: ContrailConfig,
  opts: BuilderOpts = {},
): Promise<void> {
  for (const stmt of buildCountColumns(config, opts)) {
    const match = stmt.match(
      /^ALTER TABLE\s+(\S+)\s+ADD COLUMN\s+(\S+)\s+(.+)$/i,
    );
    if (match) {
      const [, table, column, columnDef] = match;
      await addColumnIfNotExists(db, table, column, columnDef);
    } else {
      await db.prepare(stmt).run();
    }
  }
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
    // Single-row cursor for the rolling, bounded feed prune (see sweepFeedItems).
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
    Object.values(config.feeds).map((f) => f.follow ?? "follow")
  );
  for (const col of followCollections) {
    const table = recordsTableName(col);
    const safe = sanitizeName(col);
    stmts.push(
      `CREATE INDEX IF NOT EXISTS idx_${safe}_subject ON ${table}(${dialect.indexExpression(dialect.jsonExtract('record', 'subject'))})`
    );
  }

  return stmts;
}

export function buildFtsTables(
  config: ContrailConfig,
  dialect: SqlDialect,
  opts: BuilderOpts = {}
): string[] {
  const stmts: string[] = [];
  for (const [collection, colConfig] of Object.entries(config.collections)) {
    if (opts.forSpaces && colConfig.allowInSpaces === false) continue;
    const fields = getSearchableFields(collection, colConfig);
    if (!fields || fields.length === 0) continue;
    const table = tableFor(collection, opts);
    stmts.push(...buildFtsSchema(dialect, table, fields));
  }
  return stmts;
}

/**
 * Schema migrations expressed as structured ADD-COLUMN ops. Each entry is
 * applied via `addColumnIfNotExists` so the operation is idempotent on both
 * dialects without swallowing genuine DDL errors.
 *
 * `target: "spaces"` is routed to the spaces DB (which may differ from the
 * main DB in split-DB deployments) and only applied when spaces is enabled.
 * `target: "feeds"` is only applied when feeds are configured (the
 * `feed_backfills` table doesn't exist otherwise). All other migrations
 * target the main DB unconditionally.
 */
interface MigrationOp {
  table: string;
  column: string;
  columnDef: string;
  target?: "spaces" | "feeds";
}

const MIGRATIONS: MigrationOp[] = [
  { table: "backfills", column: "retries", columnDef: "INTEGER NOT NULL DEFAULT 0" },
  { table: "backfills", column: "last_error", columnDef: "TEXT" },
  {
    table: "spaces_invites",
    column: "kind",
    columnDef: "TEXT NOT NULL DEFAULT 'join'",
    target: "spaces",
  },
  { table: "feed_backfills", column: "retries", columnDef: "INTEGER NOT NULL DEFAULT 0", target: "feeds" },
  { table: "feed_backfills", column: "last_error", columnDef: "TEXT", target: "feeds" },
  { table: "feed_backfills", column: "started_at", columnDef: "BIGINT", target: "feeds" },
];

async function runMigrations(
  db: Database,
  spacesDb: Database | undefined,
  hasSpaces: boolean,
  hasFeeds: boolean,
): Promise<void> {
  for (const op of MIGRATIONS) {
    if (op.target === "spaces") {
      if (!hasSpaces) continue;
      await addColumnIfNotExists(spacesDb ?? db, op.table, op.column, op.columnDef);
      continue;
    }
    if (op.target === "feeds") {
      if (!hasFeeds) continue;
      await addColumnIfNotExists(db, op.table, op.column, op.columnDef);
      continue;
    }
    await addColumnIfNotExists(db, op.table, op.column, op.columnDef);
  }
}

/** Pluggable schema applier — passed in by extension packages (community,
 *  third-party plugins) to install their own tables alongside contrail's. */
export type SchemaModule = (db: Database) => Promise<void>;

export interface InitSchemaOptions {
  /** Separate DB for the spaces tables. Defaults to the main `db`. */
  spacesDb?: Database;
  /** Extra schema modules to apply after contrail's own DDL. Used by the
   *  community package to install its tables — contrail core no longer
   *  imports community schema directly. */
  extraSchemas?: SchemaModule[];
}

async function applySpacesSchema(
  target: Database,
  config: ContrailConfig,
  dialect: SqlDialect
): Promise<void> {
  const base = buildSpacesBaseSchema(dialect);
  const perCollection = buildCollectionTables(config, dialect, { forSpaces: true });
  const indexes = buildDynamicIndexes(config, dialect, { forSpaces: true });
  // Per-statement (not batched) so concurrent applySpacesSchema on Postgres
  // races only on the individual CREATE statements; see initSchema for
  // rationale.
  for (const stmt of [...base, ...perCollection, ...indexes]) {
    await runIdempotentDdl(target, stmt);
  }

  const ftsStmts = buildFtsTables(config, dialect, { forSpaces: true });
  for (const stmt of ftsStmts) {
    try { await target.prepare(stmt).run(); } catch { /* FTS5 unavailable */ }
  }
  // Idempotent count-column ALTERs + their indexes. Non-duplicate-column
  // errors propagate.
  await applyCountColumns(target, config, { forSpaces: true });
}

export async function initSchema(
  db: Database,
  config: ContrailConfig,
  options: InitSchemaOptions = {}
): Promise<void> {
  const dialect = getDialect(db);
  const baseStatements = buildBaseSchema(dialect).split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const collectionStatements = buildCollectionTables(config, dialect);
  const indexStatements = buildDynamicIndexes(config, dialect);
  const ftsStatements = buildFtsTables(config, dialect);
  const feedStatements = buildFeedTables(config, dialect);

  const spacesDb = options.spacesDb;
  const spacesSharesMainDb = !spacesDb || spacesDb === db;

  const all = [...baseStatements, ...collectionStatements, ...indexStatements, ...feedStatements];

  // Per-statement run (not a batched transaction) so concurrent initSchema
  // callers on Postgres race only on individual CREATEs; the loser's
  // duplicate-relation error is absorbed by runIdempotentDdl. Each statement
  // is already idempotent (IF NOT EXISTS).
  for (const stmt of all) {
    await runIdempotentDdl(db, stmt);
  }

  if (config.spaces?.authority || config.spaces?.recordHost) {
    await applySpacesSchema(spacesSharesMainDb ? db : spacesDb!, config, dialect);
  }

  // Extension schemas (e.g. community) — applied to the spacesDb when one's
  // configured separately, since they typically reference space_uri. The
  // caller is responsible for routing the schema to the right db; we just
  // hand it the spaces-or-main DB as a sensible default.
  const extensionTarget = spacesSharesMainDb ? db : spacesDb!;
  for (const apply of options.extraSchemas ?? []) {
    await apply(extensionTarget);
  }

  if (config.labels) {
    // Labels tables live on the main DB — they're keyed by at-URI / DID and
    // are read alongside public records during hydration.
    const labelsStmts = buildLabelsSchema(dialect);
    for (const stmt of labelsStmts) {
      await runIdempotentDdl(db, stmt);
    }
  }

  // FTS5 may not be available (e.g. node:sqlite) — skip gracefully
  for (const stmt of ftsStatements) {
    try {
      await db.prepare(stmt).run();
    } catch {
      // FTS5 not supported in this environment
    }
  }
  const hasSpaces = !!(config.spaces?.authority || config.spaces?.recordHost);
  const hasFeeds = !!(config.feeds && Object.keys(config.feeds).length > 0);
  // Spaces-targeted migrations route to spacesDb when one is configured;
  // otherwise they hit the main db (which is where the spaces tables live
  // when no separate spacesDb is supplied).
  await runMigrations(db, spacesSharesMainDb ? undefined : spacesDb, hasSpaces, hasFeeds);

  // Idempotent count-column ALTERs + their indexes. Routed through
  // `applyCountColumns` so non-duplicate-column errors propagate.
  await applyCountColumns(db, config);
}
