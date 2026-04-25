import type { ContrailConfig, Database, ResolvedContrailConfig, ResolvedMaps } from "../types";
import type { SqlDialect } from "../dialect";
import { buildFtsSchema, getDialect } from "../dialect";
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
import { buildCommunitySchema } from "../community/schema";
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

const MIGRATIONS = [
  "ALTER TABLE backfills ADD COLUMN retries INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE backfills ADD COLUMN last_error TEXT",
  "ALTER TABLE spaces_invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'join'",
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

export interface InitSchemaOptions {
  /** Separate DB for the spaces tables. Defaults to the main `db`. */
  spacesDb?: Database;
}

async function applySpacesSchema(
  target: Database,
  config: ContrailConfig,
  dialect: SqlDialect
): Promise<void> {
  const base = buildSpacesBaseSchema(dialect);
  const perCollection = buildCollectionTables(config, dialect, { forSpaces: true });
  const indexes = buildDynamicIndexes(config, dialect, { forSpaces: true });
  await target.batch([...base, ...perCollection, ...indexes].map((s) => target.prepare(s)));

  const ftsStmts = buildFtsTables(config, dialect, { forSpaces: true });
  for (const stmt of ftsStmts) {
    try { await target.prepare(stmt).run(); } catch { /* FTS5 unavailable */ }
  }
  for (const stmt of buildCountColumns(config, { forSpaces: true })) {
    try { await target.prepare(stmt).run(); } catch { /* already exists */ }
  }
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

  await db.batch(all.map((s) => db.prepare(s)));

  if (config.spaces) {
    await applySpacesSchema(spacesSharesMainDb ? db : spacesDb!, config, dialect);
  }

  if (config.community) {
    // Community tables live on the same DB as spaces (they reference space_uri).
    const target = spacesSharesMainDb ? db : spacesDb!;
    const communityStmts = buildCommunitySchema(dialect);
    await target.batch(communityStmts.map((s) => target.prepare(s)));
  }

  if (config.labels) {
    // Labels tables live on the main DB — they're keyed by at-URI / DID and
    // are read alongside public records during hydration.
    const labelsStmts = buildLabelsSchema(dialect);
    await db.batch(labelsStmts.map((s) => db.prepare(s)));
  }

  // FTS5 may not be available (e.g. node:sqlite) — skip gracefully
  for (const stmt of ftsStatements) {
    try {
      await db.prepare(stmt).run();
    } catch {
      // FTS5 not supported in this environment
    }
  }
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
