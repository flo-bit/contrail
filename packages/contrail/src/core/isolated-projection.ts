import type {
  ContrailConfig,
  Database,
  IngestEvent,
  RecordRow,
  RelationConfig,
  ResolvedContrailConfig,
  Statement,
} from "./types";
import {
  countColumnName,
  getNestedValue,
  getRelationField,
  groupedCountColumnName,
  nsidForShortName,
  recordsTableName,
  resolveCollectionKey,
  shortNameForNsid,
} from "./types";
import type { IngestProjection, IngestRecordsOptions } from "./ingest";
import {
  compareRecordVersions,
  type MutationSelection,
  type RecordVersionInfo,
  type SortOption,
} from "./db/records";
import {
  buildFtsSchema,
  getDialect,
} from "./dialect";
import {
  buildFtsContent,
  getSearchableFields,
} from "./search";

/** A protocol-neutral projection boundary. Core deliberately does not interpret
 * isolated keys; an extension maps its authority/generation identity to one. */
export type ProjectionScope =
  | { kind: "public" }
  | { kind: "isolated"; key: string };

/** A mutation target inside an isolated scope. Partition generations allow a
 * complete source partition to be staged and atomically made visible. */
export interface IsolatedProjectionTarget {
  scope: { kind: "isolated"; key: string };
  partition: string;
  generation: number;
  /** Switch this partition's visible pointer in the projection transaction. */
  activate?: boolean;
}

export interface IsolatedQueryOptions {
  scope: { kind: "isolated"; key: string };
  collection: string;
  did?: string;
  uri?: string;
  limit?: number;
  cursor?: string;
  filters?: Record<string, string>;
  rangeFilters?: Record<string, { min?: string; max?: string }>;
  countFilters?: Record<string, number>;
  sort?: SortOption;
  search?: string;
}

export interface IsolatedQueryResult {
  records: Array<RecordRow & { counts?: Record<string, number> }>;
  cursor?: string;
  /** Exact-Space forward-reference targets keyed by URI. */
  references?: Record<string, RecordRow>;
}

const MAX_BINDINGS = 100;
const SAFE_KEY = /^[a-zA-Z0-9_.]+$/;

function safeSuffix(short: string): string {
  return short.replace(/[^a-zA-Z0-9]/g, "_");
}

export function isolatedRecordsTableName(short: string): string {
  return `isolated_${recordsTableName(short)}`;
}

export function isolatedFtsTableName(short: string): string {
  return `isolated_fts_${safeSuffix(short)}`;
}

export function isolatedFtsRowsTableName(short: string): string {
  return `${isolatedFtsTableName(short)}_rows`;
}

function assertTarget(target: IsolatedProjectionTarget): void {
  if (!target.scope.key) throw new TypeError("isolated scope key must not be empty");
  if (!target.partition) throw new TypeError("isolated partition must not be empty");
  if (!Number.isSafeInteger(target.generation) || target.generation < 0) {
    throw new TypeError("isolated partition generation must be a non-negative integer");
  }
}

function countColumns(config: ContrailConfig, short: string): Array<{
  type: string;
  column: string;
}> {
  const result = new Map<string, string>();
  const collection = config.collections[short];
  if (!collection) return [];
  const mappings = (config as ResolvedContrailConfig)._resolved?.relations[short] ?? {};
  for (const [name, relation] of Object.entries(collection.relations ?? {})) {
    if (relation.count === false) continue;
    result.set(countColumnName(relation.collection), relation.collection);
    for (const [group, token] of Object.entries(mappings[name]?.groups ?? {})) {
      result.set(groupedCountColumnName(relation.collection, group), token);
    }
  }
  return [...result].map(([column, type]) => ({ type, column }));
}

async function isolatedTableColumns(
  db: Database,
  table: string,
): Promise<Set<string>> {
  if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new TypeError(`invalid table name: ${table}`);
  const dialect = getDialect(db);
  if (dialect.ftsStrategy === "virtual-table") {
    const rows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return new Set((rows.results ?? []).map((row) => String(row.name)));
  }
  const rows = await db.prepare(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ?`,
  ).bind(table).all<{ column_name: string }>();
  return new Set((rows.results ?? []).map((row) => String(row.column_name)));
}

async function ensureIsolatedCountColumns(
  db: Database,
  table: string,
  columns: readonly string[],
): Promise<void> {
  if (columns.length === 0) return;
  let existing = await isolatedTableColumns(db, table);
  for (const column of columns) {
    if (!/^[a-zA-Z0-9_]+$/.test(column)) {
      throw new TypeError(`invalid isolated count column: ${column}`);
    }
    if (existing.has(column)) continue;
    try {
      await db.prepare(
        `ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
      ).run();
    } catch (error) {
      // Concurrent Worker initialization can race the same additive migration.
      // Suppress only when a fresh schema read proves the column now exists.
      existing = await isolatedTableColumns(db, table);
      if (!existing.has(column)) throw error;
      continue;
    }
    existing.add(column);
  }
}

function countColumnForType(
  config: ContrailConfig,
  short: string,
  type: string,
): string | null {
  return countColumns(config, short).find((item) => item.type === type)?.column ?? null;
}

/** Initialize only the extension-owned isolated namespace. Public-only Contrail
 * installs never call this and therefore receive no private tables. */
export async function initIsolatedProjection(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  const dialect = getDialect(db);
  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS isolated_projection_partitions (
      scope_key TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      visible_generation INTEGER NOT NULL,
      updated_at ${dialect.bigintType} NOT NULL,
      PRIMARY KEY (scope_key, partition_key)
    )`,
    `CREATE TABLE IF NOT EXISTS isolated_record_versions (
      scope_key TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      partition_generation INTEGER NOT NULL,
      uri TEXT NOT NULL,
      did TEXT NOT NULL,
      collection TEXT NOT NULL,
      rkey TEXT NOT NULL,
      operation TEXT NOT NULL,
      cid TEXT,
      source_id TEXT NOT NULL,
      source_epoch TEXT,
      source_revision TEXT,
      source_time_us ${dialect.bigintType} NOT NULL,
      source_cursor TEXT,
      indexed_at ${dialect.bigintType} NOT NULL,
      PRIMARY KEY (scope_key, partition_key, partition_generation, uri)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_isolated_versions_uri
      ON isolated_record_versions(scope_key, uri)`,
  ];

  const relationIndexes: string[] = [];
  const countMigrations: Array<{ table: string; columns: string[] }> = [];
  for (const [short, collection] of Object.entries(config.collections)) {
    const table = isolatedRecordsTableName(short);
    const requiredCountColumns = countColumns(config, short).map(({ column }) => column);
    countMigrations.push({ table, columns: requiredCountColumns });
    const extraColumns = requiredCountColumns
      .map((column) => `${column} INTEGER NOT NULL DEFAULT 0`)
      .join(",\n      ");
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${table} (
        scope_key TEXT NOT NULL,
        partition_key TEXT NOT NULL,
        partition_generation INTEGER NOT NULL,
        uri TEXT NOT NULL,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        cid TEXT,
        record ${dialect.recordColumnType} NOT NULL,
        time_us ${dialect.bigintType} NOT NULL,
        indexed_at ${dialect.bigintType} NOT NULL${extraColumns ? `,\n        ${extraColumns}` : ""},
        PRIMARY KEY (scope_key, partition_key, partition_generation, uri)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_${table}_scope_time
        ON ${table}(scope_key, time_us DESC, uri)`,
      `CREATE INDEX IF NOT EXISTS idx_${table}_scope_did
        ON ${table}(scope_key, did, time_us DESC, uri)`,
    );

    for (const field of Object.keys(collection.queryable ?? {})) {
      if (!SAFE_KEY.test(field)) throw new TypeError(`invalid isolated query field: ${field}`);
      statements.push(
        `CREATE INDEX IF NOT EXISTS idx_${table}_${safeSuffix(field)}
          ON ${table}(scope_key, ${dialect.indexExpression(dialect.jsonExtract("record", field))})`,
      );
    }
    for (const relation of Object.values(collection.relations ?? {})) {
      const child = isolatedRecordsTableName(relation.collection);
      const field = getRelationField(relation);
      relationIndexes.push(
        `CREATE INDEX IF NOT EXISTS idx_${child}_${safeSuffix(field)}
          ON ${child}(scope_key, ${dialect.indexExpression(dialect.jsonExtract("record", field))})`,
      );
    }

    const fields = getSearchableFields(short, collection);
    if (fields?.length) {
      if (dialect.ftsStrategy === "virtual-table") {
        const rows = isolatedFtsRowsTableName(short);
        const fts = isolatedFtsTableName(short);
        statements.push(
          `CREATE TABLE IF NOT EXISTS ${rows} (
            id INTEGER PRIMARY KEY,
            scope_key TEXT NOT NULL,
            partition_key TEXT NOT NULL,
            partition_generation INTEGER NOT NULL,
            uri TEXT NOT NULL,
            UNIQUE(scope_key, partition_key, partition_generation, uri)
          )`,
          `CREATE INDEX IF NOT EXISTS idx_${rows}_scope_uri ON ${rows}(scope_key, uri)`,
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(content)`,
        );
      } else {
        statements.push(...buildFtsSchema(dialect, table, fields));
      }
    }
  }

  statements.push(...relationIndexes);
  for (const sql of statements) {
    try {
      await db.prepare(sql).run();
    } catch (error) {
      // SQLite builds without FTS5 keep canonical isolated records available,
      // matching Contrail's existing public-schema behavior.
      if (!/VIRTUAL TABLE|fts5/i.test(sql)) throw error;
    }
  }
  for (const migration of countMigrations) {
    await ensureIsolatedCountColumns(db, migration.table, migration.columns);
  }
}

function versionForEvent(event: IngestEvent): RecordVersionInfo {
  const source = event.source ?? {
    id: "legacy-caller",
    epoch: null,
    time_us: event.indexed_at,
    revision: null,
    cursor: null,
  };
  return {
    uri: event.uri,
    did: event.did,
    collection: event.collection,
    rkey: event.rkey,
    operation: event.operation,
    cid: event.cid,
    source_id: source.id,
    source_epoch: source.epoch ?? null,
    source_revision: source.revision,
    source_time_us: source.time_us,
    source_cursor: source.cursor,
    indexed_at: event.indexed_at,
  };
}

async function isolatedVersions(
  db: Database,
  target: IsolatedProjectionTarget,
  uris: Iterable<string>,
): Promise<Map<string, RecordVersionInfo>> {
  const values = [...new Set(uris)];
  const result = new Map<string, RecordVersionInfo>();
  for (let offset = 0; offset < values.length; offset += 40) {
    const chunk = values.slice(offset, offset + 40);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT uri, did, collection, rkey, operation, cid, source_id,
                source_epoch, source_revision, source_time_us, source_cursor, indexed_at
         FROM isolated_record_versions
         WHERE scope_key = ? AND partition_key = ? AND partition_generation = ?
           AND uri IN (${placeholders})`,
      )
      .bind(target.scope.key, target.partition, target.generation, ...chunk)
      .all<RecordVersionInfo>();
    for (const row of rows.results ?? []) result.set(row.uri, row);
  }
  return result;
}

function mutationWinners(
  events: IngestEvent[],
  durable: ReadonlyMap<string, RecordVersionInfo>,
): MutationSelection {
  const winners = new Map<string, {
    event: IngestEvent;
    version: RecordVersionInfo;
    index: number;
  }>();
  let superseded = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const version = versionForEvent(event);
    const previous = winners.get(event.uri);
    const current = previous?.version ?? durable.get(event.uri);
    if (current && compareRecordVersions(version, current) <= 0) {
      superseded++;
      continue;
    }
    if (previous) superseded++;
    winners.set(event.uri, { event, version, index });
  }
  return {
    applied: [...winners.values()]
      .sort((left, right) => left.index - right.index)
      .map(({ event }) => event),
    superseded,
  };
}

interface Existing {
  cid: string | null;
  record: string | null;
}

async function existingRecords(
  db: Database,
  target: IsolatedProjectionTarget,
  events: IngestEvent[],
  config: ContrailConfig,
): Promise<Map<string, Existing>> {
  const result = new Map<string, Existing>();
  const byCollection = new Map<string, string[]>();
  for (const event of events) {
    const short = resolveCollectionKey(config, event.collection);
    if (!short) continue;
    const uris = byCollection.get(short) ?? [];
    uris.push(event.uri);
    byCollection.set(short, uris);
  }
  for (const [short, uris] of byCollection) {
    const table = isolatedRecordsTableName(short);
    for (let offset = 0; offset < uris.length; offset += 40) {
      const chunk = uris.slice(offset, offset + 40);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await db
        .prepare(
          `SELECT uri, cid, record FROM ${table}
           WHERE scope_key = ? AND partition_key = ? AND partition_generation = ?
             AND uri IN (${placeholders})`,
        )
        .bind(target.scope.key, target.partition, target.generation, ...chunk)
        .all<{ uri: string; cid: string | null; record: string | null }>();
      for (const row of rows.results ?? []) result.set(row.uri, row);
    }
  }
  return result;
}

function recordStatements(
  db: Database,
  target: IsolatedProjectionTarget,
  events: IngestEvent[],
  config: ContrailConfig,
): Statement[] {
  const result: Statement[] = [];
  const grouped = new Map<string, { upserts: IngestEvent[]; deletes: IngestEvent[] }>();
  for (const event of events) {
    const short = resolveCollectionKey(config, event.collection);
    if (!short) continue;
    const table = isolatedRecordsTableName(short);
    const group = grouped.get(table) ?? { upserts: [], deletes: [] };
    (event.operation === "delete" ? group.deletes : group.upserts).push(event);
    grouped.set(table, group);
  }
  const upsertRows = Math.floor(MAX_BINDINGS / 10);
  for (const [table, group] of grouped) {
    for (let offset = 0; offset < group.upserts.length; offset += upsertRows) {
      const chunk = group.upserts.slice(offset, offset + upsertRows);
      result.push(
        db.prepare(
          `INSERT INTO ${table}
             (scope_key, partition_key, partition_generation, uri, did, rkey, cid, record, time_us, indexed_at)
           VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",")}
           ON CONFLICT(scope_key, partition_key, partition_generation, uri)
           DO UPDATE SET did = excluded.did, rkey = excluded.rkey, cid = excluded.cid,
             record = excluded.record, time_us = excluded.time_us,
             indexed_at = excluded.indexed_at`,
        ).bind(...chunk.flatMap((event) => [
          target.scope.key,
          target.partition,
          target.generation,
          event.uri,
          event.did,
          event.rkey,
          event.cid,
          event.record,
          event.time_us,
          event.indexed_at,
        ])),
      );
    }
    for (let offset = 0; offset < group.deletes.length; offset += 40) {
      const chunk = group.deletes.slice(offset, offset + 40);
      const placeholders = chunk.map(() => "?").join(",");
      result.push(
        db.prepare(
          `DELETE FROM ${table}
           WHERE scope_key = ? AND partition_key = ? AND partition_generation = ?
             AND uri IN (${placeholders})`,
        ).bind(
          target.scope.key,
          target.partition,
          target.generation,
          ...chunk.map(({ uri }) => uri),
        ),
      );
    }
  }
  return result;
}

function versionStatements(
  db: Database,
  target: IsolatedProjectionTarget,
  events: IngestEvent[],
  existing: ReadonlyMap<string, Existing>,
): Statement[] {
  const result: Statement[] = [];
  const rowsPerStatement = Math.floor(MAX_BINDINGS / 15);
  for (let offset = 0; offset < events.length; offset += rowsPerStatement) {
    const chunk = events.slice(offset, offset + rowsPerStatement);
    result.push(
      db.prepare(
        `INSERT INTO isolated_record_versions
          (scope_key, partition_key, partition_generation, uri, did, collection,
           rkey, operation, cid, source_id, source_epoch, source_revision,
           source_time_us, source_cursor, indexed_at)
         VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",")}
         ON CONFLICT(scope_key, partition_key, partition_generation, uri)
         DO UPDATE SET did = excluded.did, collection = excluded.collection,
           rkey = excluded.rkey, operation = excluded.operation, cid = excluded.cid,
           source_id = excluded.source_id, source_epoch = excluded.source_epoch,
           source_revision = excluded.source_revision,
           source_time_us = excluded.source_time_us,
           source_cursor = excluded.source_cursor, indexed_at = excluded.indexed_at`,
      ).bind(...chunk.flatMap((event) => {
        const version = versionForEvent(event);
        const cid = event.operation === "delete"
          ? (version.cid ?? existing.get(event.uri)?.cid ?? null)
          : version.cid;
        return [
          target.scope.key,
          target.partition,
          target.generation,
          version.uri,
          version.did,
          version.collection,
          version.rkey,
          version.operation,
          cid,
          version.source_id,
          version.source_epoch,
          version.source_revision,
          version.source_time_us,
          version.source_cursor,
          version.indexed_at,
        ];
      })),
    );
  }
  return result;
}

export function activateIsolatedPartitionStatement(
  db: Database,
  target: IsolatedProjectionTarget,
): Statement {
  assertTarget(target);
  return db.prepare(
    `INSERT INTO isolated_projection_partitions
       (scope_key, partition_key, visible_generation, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope_key, partition_key)
     DO UPDATE SET visible_generation = excluded.visible_generation,
                   updated_at = excluded.updated_at`,
  ).bind(
    target.scope.key,
    target.partition,
    target.generation,
    Date.now() * 1000,
  );
}

function ftsStatements(
  db: Database,
  target: IsolatedProjectionTarget,
  event: IngestEvent,
  config: ContrailConfig,
): Statement[] {
  if (getDialect(db).ftsStrategy === "generated-column") return [];
  const short = resolveCollectionKey(config, event.collection);
  if (!short) return [];
  const fields = getSearchableFields(short, config.collections[short]);
  if (!fields?.length) return [];
  const fts = isolatedFtsTableName(short);
  const rows = isolatedFtsRowsTableName(short);
  const bindings = [
    target.scope.key,
    target.partition,
    target.generation,
    event.uri,
  ] as const;
  const deleteContent = () => db.prepare(
    `DELETE FROM ${fts} WHERE rowid = (
       SELECT id FROM ${rows}
       WHERE scope_key = ? AND partition_key = ? AND partition_generation = ? AND uri = ?
     )`,
  ).bind(...bindings);
  const deleteMapping = () => db.prepare(
    `DELETE FROM ${rows}
     WHERE scope_key = ? AND partition_key = ? AND partition_generation = ? AND uri = ?`,
  ).bind(...bindings);
  if (event.operation === "delete") return [deleteContent(), deleteMapping()];
  const record = event.record ? JSON.parse(event.record) : null;
  const content = record ? buildFtsContent(record, fields) : "";
  if (!content) return [deleteContent(), deleteMapping()];
  return [
    db.prepare(
      getDialect(db).insertOrIgnore(
        `INSERT INTO ${rows}
           (scope_key, partition_key, partition_generation, uri)
         VALUES (?, ?, ?, ?)`,
      ),
    ).bind(...bindings),
    deleteContent(),
    db.prepare(
      `INSERT INTO ${fts} (rowid, content)
       SELECT id, ? FROM ${rows}
       WHERE scope_key = ? AND partition_key = ? AND partition_generation = ? AND uri = ?`,
    ).bind(content, ...bindings),
  ];
}

type CountTarget = {
  parent: string;
  relationName: string;
  relation: RelationConfig;
  value: string;
};

function countTargetKey(target: CountTarget): string {
  return `${target.parent}\0${target.relationName}\0${target.value}`;
}

function collectCountTargets(
  targetMap: Map<string, CountTarget>,
  event: IngestEvent,
  existing: Existing | undefined,
  config: ContrailConfig,
): void {
  const child = resolveCollectionKey(config, event.collection);
  if (!child) return;
  const current = event.record ? JSON.parse(event.record) : null;
  const previous = existing?.record ? JSON.parse(existing.record) : null;
  for (const [parent, parentConfig] of Object.entries(config.collections)) {
    for (const [relationName, relation] of Object.entries(parentConfig.relations ?? {})) {
      if (relation.collection !== child || relation.count === false) continue;
      const values = new Set<string>();
      for (const record of [current, previous]) {
        const value = record ? getNestedValue(record, getRelationField(relation)) : null;
        if (typeof value === "string") values.add(value);
      }
      for (const value of values) {
        const target = { parent, relationName, relation, value };
        targetMap.set(countTargetKey(target), target);
      }
    }
  }
  if (event.operation !== "delete") {
    const parent = child;
    for (const [relationName, relation] of Object.entries(
      config.collections[parent]?.relations ?? {},
    )) {
      if (relation.count === false) continue;
      const value = relation.match === "did" ? event.did : event.uri;
      const target = { parent, relationName, relation, value };
      targetMap.set(countTargetKey(target), target);
    }
  }
}

function visibleJoin(alias: string, visibleAlias: string): string {
  return `JOIN isolated_projection_partitions ${visibleAlias}
    ON ${visibleAlias}.scope_key = ${alias}.scope_key
   AND ${visibleAlias}.partition_key = ${alias}.partition_key
   AND ${visibleAlias}.visible_generation = ${alias}.partition_generation`;
}

function countStatementsForTargets(
  db: Database,
  scopeKey: string,
  config: ContrailConfig,
  targets: Iterable<CountTarget>,
): Statement[] {
  const dialect = getDialect(db);
  const statements: Statement[] = [];
  for (const { parent, relationName, relation, value } of targets) {
    const parentTable = isolatedRecordsTableName(parent);
    const childTable = isolatedRecordsTableName(relation.collection);
    const childTarget = dialect.jsonExtract("child.record", getRelationField(relation));
    const parentColumn = relation.match === "did" ? "did" : "uri";
    const distinct = relation.countDistinct;
    const distinctExpression = distinct
      ? ["uri", "did", "rkey"].includes(distinct)
        ? `child.${distinct}`
        : dialect.jsonExtract("child.record", distinct)
      : null;
    const aggregate = distinctExpression
      ? `COUNT(DISTINCT ${distinctExpression})`
      : "COUNT(*)";
    const sets: string[] = [
      `${countColumnName(relation.collection)} = (
        SELECT ${aggregate} FROM ${childTable} child
        ${visibleJoin("child", "child_visible")}
        WHERE child.scope_key = ? AND ${childTarget} = ?
      )`,
    ];
    const bindings: Array<string | number> = [scopeKey, value];
    const mapping = (config as ResolvedContrailConfig)._resolved?.relations[parent]?.[
      relationName
    ];
    if (relation.groupBy && mapping?.groups) {
      const groupExpression = dialect.jsonExtract("child.record", relation.groupBy);
      for (const [group, token] of Object.entries(mapping.groups)) {
        sets.push(
          `${groupedCountColumnName(relation.collection, group)} = (
            SELECT ${aggregate} FROM ${childTable} child
            ${visibleJoin("child", "child_visible")}
            WHERE child.scope_key = ? AND ${childTarget} = ? AND ${groupExpression} = ?
          )`,
        );
        bindings.push(scopeKey, value, token);
      }
    }
    statements.push(
      db.prepare(
        `UPDATE ${parentTable} AS parent SET ${sets.join(", ")}
         WHERE parent.scope_key = ? AND parent.${parentColumn} = ?
           AND EXISTS (
             SELECT 1 FROM isolated_projection_partitions parent_visible
             WHERE parent_visible.scope_key = parent.scope_key
               AND parent_visible.partition_key = parent.partition_key
               AND parent_visible.visible_generation = parent.partition_generation
           )`,
      ).bind(...bindings, scopeKey, value),
    );
  }
  return statements;
}

/** Recompute every materialized relation count in one isolated scope. Intended
 * for the final transaction of a staged full-partition recovery, immediately
 * after its visibility pointer switches. */
export function rebuildIsolatedCountsStatements(
  db: Database,
  config: ContrailConfig,
  scope: { kind: "isolated"; key: string },
): Statement[] {
  const dialect = getDialect(db);
  const statements: Statement[] = [];
  for (const [parentShort, parentConfig] of Object.entries(config.collections)) {
    const parentTable = isolatedRecordsTableName(parentShort);
    for (const [relationName, relation] of Object.entries(parentConfig.relations ?? {})) {
      if (relation.count === false) continue;
      const childTable = isolatedRecordsTableName(relation.collection);
      const childTarget = dialect.jsonExtract("child.record", getRelationField(relation));
      const parentTarget = relation.match === "did" ? "parent.did" : "parent.uri";
      const distinct = relation.countDistinct;
      const distinctExpression = distinct
        ? ["uri", "did", "rkey"].includes(distinct)
          ? `child.${distinct}`
          : dialect.jsonExtract("child.record", distinct)
        : null;
      const aggregate = distinctExpression
        ? `COUNT(DISTINCT ${distinctExpression})`
        : "COUNT(*)";
      const sets = [
        `${countColumnName(relation.collection)} = (
          SELECT ${aggregate} FROM ${childTable} child
          ${visibleJoin("child", "child_visible")}
          WHERE child.scope_key = parent.scope_key AND ${childTarget} = ${parentTarget}
        )`,
      ];
      const bindings: string[] = [];
      const mapping = (config as ResolvedContrailConfig)._resolved?.relations[
        parentShort
      ]?.[relationName];
      if (relation.groupBy && mapping?.groups) {
        const groupExpression = dialect.jsonExtract("child.record", relation.groupBy);
        for (const [group, token] of Object.entries(mapping.groups)) {
          sets.push(
            `${groupedCountColumnName(relation.collection, group)} = (
              SELECT ${aggregate} FROM ${childTable} child
              ${visibleJoin("child", "child_visible")}
              WHERE child.scope_key = parent.scope_key
                AND ${childTarget} = ${parentTarget}
                AND ${groupExpression} = ?
            )`,
          );
          bindings.push(token);
        }
      }
      const statement = db.prepare(
        `UPDATE ${parentTable} AS parent SET ${sets.join(", ")}
         WHERE parent.scope_key = ?
           AND EXISTS (
             SELECT 1 FROM isolated_projection_partitions parent_visible
             WHERE parent_visible.scope_key = parent.scope_key
               AND parent_visible.partition_key = parent.partition_key
               AND parent_visible.visible_generation = parent.partition_generation
           )`,
      );
      statements.push(statement.bind(...bindings, scope.key));
    }
  }
  return statements;
}

class IsolatedProjector implements IngestProjection {
  constructor(readonly target: IsolatedProjectionTarget) {
    assertTarget(target);
  }

  async selectCurrent(db: Database, events: IngestEvent[]): Promise<MutationSelection> {
    const durable = await isolatedVersions(db, this.target, events.map(({ uri }) => uri));
    return mutationWinners(events, durable);
  }

  async project(
    db: Database,
    input: IngestEvent[],
    config: ContrailConfig,
    options: IngestRecordsOptions & { sourceOrderingChecked: true },
  ): Promise<MutationSelection> {
    let selection: MutationSelection = { applied: input, superseded: 0 };
    if (!options.sourceOrderingChecked) {
      selection = await this.selectCurrent(db, input);
    }
    const events = selection.applied;
    if (events.length === 0) {
      if (options.trailingStatements?.length) await db.batch(options.trailingStatements);
      return selection;
    }
    const existing = await existingRecords(db, this.target, events, config);
    const batch: Statement[] = [
      ...recordStatements(db, this.target, events, config),
      ...versionStatements(db, this.target, events, existing),
    ];
    if (this.target.activate) {
      batch.push(activateIsolatedPartitionStatement(db, this.target));
    }
    if (!options.skipDerivedProjections) {
      for (const event of events) {
        batch.push(...ftsStatements(db, this.target, event, config));
      }
      const targets = new Map<string, CountTarget>();
      for (const event of events) {
        collectCountTargets(targets, event, existing.get(event.uri), config);
      }
      batch.push(
        ...countStatementsForTargets(db, this.target.scope.key, config, targets.values()),
      );
    }
    if (options.trailingStatements?.length) batch.push(...options.trailingStatements);
    await db.batch(batch);
    return selection;
  }
}

export function createIsolatedProjection(
  target: IsolatedProjectionTarget,
): IngestProjection {
  return new IsolatedProjector(target);
}

interface CursorPayload {
  t: number;
  u: string;
  v?: string | number | null;
  k: string;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeCursor(value: CursorPayload): string {
  return encodeBase64Url(JSON.stringify(value));
}

function decodeCursor(value: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(value));
    return typeof parsed?.t === "number" && typeof parsed?.u === "string" &&
      typeof parsed?.k === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function sortKind(sort?: SortOption): string {
  if (sort?.recordField) return `field:${sort.recordField}`;
  if (sort?.countType) return `count:${sort.countType}`;
  return "time";
}

function isolatedSearchClause(db: Database, short: string): {
  join: string;
  condition: string;
  order: string;
  direction: "asc" | "desc";
} {
  if (getDialect(db).ftsStrategy === "generated-column") {
    return {
      join: "",
      condition: "r.search_vector @@ plainto_tsquery('english', ?)",
      order: "ts_rank(r.search_vector, plainto_tsquery('english', ?))",
      direction: "desc",
    };
  }
  const rows = isolatedFtsRowsTableName(short);
  const fts = isolatedFtsTableName(short);
  return {
    join: `JOIN ${rows} fts_rows
      ON fts_rows.scope_key = r.scope_key
     AND fts_rows.partition_key = r.partition_key
     AND fts_rows.partition_generation = r.partition_generation
     AND fts_rows.uri = r.uri
     JOIN ${fts} fts ON fts.rowid = fts_rows.id`,
    condition: "fts.content MATCH ?",
    order: "fts.rank",
    direction: "asc",
  };
}

/** Query only rows reachable through one exact scope's visible partition map. */
export async function queryIsolatedRecords(
  db: Database,
  config: ContrailConfig,
  options: IsolatedQueryOptions,
): Promise<IsolatedQueryResult> {
  if (!options.scope.key) throw new TypeError("isolated query requires a scope key");
  const short = config.collections[options.collection]
    ? options.collection
    : shortNameForNsid(config, options.collection) ?? options.collection;
  const collection = config.collections[short];
  if (!collection) throw new TypeError(`unknown collection: ${options.collection}`);
  const table = isolatedRecordsTableName(short);
  const dialect = getDialect(db);
  const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
  const conditions = ["r.scope_key = ?"];
  const bindings: Array<string | number> = [options.scope.key];
  if (options.did) {
    conditions.push("r.did = ?");
    bindings.push(options.did);
  }
  if (options.uri) {
    conditions.push("r.uri = ?");
    bindings.push(options.uri);
  }
  for (const [field, value] of Object.entries(options.filters ?? {})) {
    conditions.push(`${dialect.jsonExtract("r.record", field)} = ?`);
    bindings.push(value);
  }
  for (const [field, range] of Object.entries(options.rangeFilters ?? {})) {
    if (range.min !== undefined) {
      conditions.push(`${dialect.jsonExtract("r.record", field)} >= ?`);
      bindings.push(range.min);
    }
    if (range.max !== undefined) {
      conditions.push(`${dialect.jsonExtract("r.record", field)} <= ?`);
      bindings.push(range.max);
    }
  }
  for (const [type, minimum] of Object.entries(options.countFilters ?? {})) {
    const column = countColumnForType(config, short, type);
    if (!column) continue;
    conditions.push(`r.${column} >= ?`);
    bindings.push(minimum);
  }

  let searchClause: ReturnType<typeof isolatedSearchClause> | null = null;
  if (options.search && getSearchableFields(short, collection)?.length) {
    searchClause = isolatedSearchClause(db, short);
    conditions.push(searchClause.condition);
    bindings.push(options.search);
  }
  const kind = options.sort ? sortKind(options.sort) : searchClause ? "search" : "time";
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    if (cursor?.k === kind) {
      const tail = "(r.time_us < ? OR (r.time_us = ? AND r.uri > ?))";
      if (options.sort?.recordField && cursor.v !== undefined) {
        const expression = dialect.jsonExtract("r.record", options.sort.recordField);
        const comparator = options.sort.direction === "desc" ? "<" : ">";
        conditions.push(
          cursor.v === null
            ? `(${expression} IS NULL AND ${tail})`
            : `(${expression} ${comparator} ? OR (${expression} = ? AND ${tail}) OR ${expression} IS NULL)`,
        );
        if (cursor.v !== null) bindings.push(cursor.v, cursor.v);
        bindings.push(cursor.t, cursor.t, cursor.u);
      } else if (options.sort?.countType) {
        const column = countColumnForType(config, short, options.sort.countType);
        if (!column) throw new TypeError(`unknown count type: ${options.sort.countType}`);
        const comparator = options.sort.direction === "desc" ? "<" : ">";
        const value = Number(cursor.v ?? 0);
        conditions.push(
          `(r.${column} ${comparator} ? OR (r.${column} = ? AND ${tail}))`,
        );
        bindings.push(value, value, cursor.t, cursor.t, cursor.u);
      } else if (searchClause && typeof cursor.v === "number") {
        const comparator = searchClause.direction === "desc" ? "<" : ">";
        conditions.push(
          `(${searchClause.order} ${comparator} ? OR (${searchClause.order} = ? AND ${tail}))`,
        );
        if (dialect.ftsStrategy === "generated-column") {
          bindings.push(
            options.search!, cursor.v, options.search!, cursor.v,
            cursor.t, cursor.t, cursor.u,
          );
        } else {
          bindings.push(cursor.v, cursor.v, cursor.t, cursor.t, cursor.u);
        }
      } else if (!searchClause) {
        conditions.push(tail);
        bindings.push(cursor.t, cursor.t, cursor.u);
      }
    }
  }

  const counts = countColumns(config, short);
  const countSelect = counts.length
    ? `, ${counts.map(({ column }) => `r.${column}`).join(", ")}`
    : "";
  const selectBindings: Array<string | number> = [];
  const fieldSelect = options.sort?.recordField
    ? `, ${dialect.jsonExtract("r.record", options.sort.recordField)} AS __sort_value`
    : "";
  const rankSelect = searchClause
    ? `, ${searchClause.order} AS __search_rank`
    : "";
  if (searchClause && dialect.ftsStrategy === "generated-column") {
    selectBindings.push(options.search!);
  }

  let orderBy = "r.time_us DESC, r.uri ASC";
  const orderBindings: Array<string | number> = [];
  if (options.sort?.recordField) {
    const direction = options.sort.direction === "desc" ? "DESC" : "ASC";
    orderBy = `${dialect.jsonExtract("r.record", options.sort.recordField)} ${direction} NULLS LAST, r.time_us DESC, r.uri ASC`;
  } else if (options.sort?.countType) {
    const column = countColumnForType(config, short, options.sort.countType);
    if (!column) throw new TypeError(`unknown count type: ${options.sort.countType}`);
    orderBy = `r.${column} ${options.sort.direction.toUpperCase()}, r.time_us DESC, r.uri ASC`;
  } else if (searchClause) {
    orderBy = `${searchClause.order} ${searchClause.direction.toUpperCase()}, r.time_us DESC, r.uri ASC`;
    if (dialect.ftsStrategy === "generated-column") orderBindings.push(options.search!);
  }

  const sql = `SELECT r.uri, r.did, r.rkey, r.cid, r.record, r.time_us, r.indexed_at
      ${countSelect}${fieldSelect}${rankSelect}
    FROM ${table} r
    ${visibleJoin("r", "visible")}
    ${searchClause?.join ?? ""}
    WHERE ${conditions.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT ?`;
  const response = await db.prepare(sql)
    .bind(...selectBindings, ...bindings, ...orderBindings, limit)
    .all<Record<string, unknown>>();
  const nsid = nsidForShortName(config, short) ?? short;
  const rawRows = response.results ?? [];
  const records = rawRows.map((row) => {
    const record: RecordRow & { counts?: Record<string, number> } = {
      uri: String(row.uri),
      did: String(row.did),
      collection: nsid,
      rkey: String(row.rkey),
      cid: row.cid === null ? null : String(row.cid),
      record: row.record === null
        ? null
        : typeof row.record === "string"
          ? row.record
          : JSON.stringify(row.record),
      time_us: Number(row.time_us),
      indexed_at: Number(row.indexed_at),
    };
    const values: Record<string, number> = {};
    for (const { type, column } of counts) {
      const value = Number(row[column] ?? 0);
      if (value) values[type] = value;
    }
    if (Object.keys(values).length) record.counts = values;
    return record;
  });

  let nextCursor: string | undefined;
  if (records.length === limit) {
    const record = records[records.length - 1];
    const raw = rawRows[rawRows.length - 1];
    let value: string | number | null | undefined;
    if (options.sort?.recordField) {
      const candidate = raw.__sort_value;
      value = typeof candidate === "string" || typeof candidate === "number"
        ? candidate
        : null;
    } else if (options.sort?.countType) {
      value = record.counts?.[options.sort.countType] ?? 0;
    } else if (searchClause) {
      value = Number(raw.__search_rank);
    }
    nextCursor = encodeCursor({
      t: record.time_us,
      u: record.uri,
      ...(value === undefined ? {} : { v: value }),
      k: kind,
    });
  }

  const references = await loadIsolatedReferences(
    db,
    config,
    options.scope,
    short,
    records,
  );
  return {
    records,
    ...(nextCursor ? { cursor: nextCursor } : {}),
    ...(Object.keys(references).length ? { references } : {}),
  };
}

async function loadIsolatedReferences(
  db: Database,
  config: ContrailConfig,
  scope: { kind: "isolated"; key: string },
  sourceShort: string,
  records: RecordRow[],
): Promise<Record<string, RecordRow>> {
  const references = config.collections[sourceShort]?.references ?? {};
  const targets = new Map<string, Set<string>>();
  for (const record of records) {
    if (!record.record) continue;
    const value = JSON.parse(record.record);
    for (const reference of Object.values(references)) {
      const uri = getNestedValue(value, reference.field);
      if (typeof uri !== "string") continue;
      const values = targets.get(reference.collection) ?? new Set<string>();
      values.add(uri);
      targets.set(reference.collection, values);
    }
  }
  const result: Record<string, RecordRow> = {};
  for (const [short, uris] of targets) {
    const table = isolatedRecordsTableName(short);
    const values = [...uris];
    for (let offset = 0; offset < values.length; offset += 40) {
      const chunk = values.slice(offset, offset + 40);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await db.prepare(
        `SELECT r.uri, r.did, r.rkey, r.cid, r.record, r.time_us, r.indexed_at
         FROM ${table} r ${visibleJoin("r", "visible")}
         WHERE r.scope_key = ? AND r.uri IN (${placeholders})`,
      ).bind(scope.key, ...chunk).all<Record<string, unknown>>();
      const nsid = nsidForShortName(config, short) ?? short;
      for (const row of rows.results ?? []) {
        result[String(row.uri)] = {
          uri: String(row.uri),
          did: String(row.did),
          collection: nsid,
          rkey: String(row.rkey),
          cid: row.cid === null ? null : String(row.cid),
          record: typeof row.record === "string" ? row.record : JSON.stringify(row.record),
          time_us: Number(row.time_us),
          indexed_at: Number(row.indexed_at),
        };
      }
    }
  }
  return result;
}

/** Remove one non-serving or retired partition generation from every isolated
 * canonical/derived table. Calling code must first move or remove visibility. */
export async function deleteIsolatedPartitionGeneration(
  db: Database,
  config: ContrailConfig,
  input: {
    scope: { kind: "isolated"; key: string };
    partition: string;
    generation: number;
  },
): Promise<void> {
  const batch: Statement[] = [];
  for (const [short, collection] of Object.entries(config.collections)) {
    if (
      getDialect(db).ftsStrategy === "virtual-table" &&
      getSearchableFields(short, collection)?.length
    ) {
      const rows = isolatedFtsRowsTableName(short);
      const fts = isolatedFtsTableName(short);
      batch.push(
        db.prepare(
          `DELETE FROM ${fts} WHERE rowid IN (
             SELECT id FROM ${rows}
             WHERE scope_key = ? AND partition_key = ? AND partition_generation = ?
           )`,
        ).bind(input.scope.key, input.partition, input.generation),
        db.prepare(
          `DELETE FROM ${rows}
           WHERE scope_key = ? AND partition_key = ? AND partition_generation = ?`,
        ).bind(input.scope.key, input.partition, input.generation),
      );
    }
    batch.push(
      db.prepare(
        `DELETE FROM ${isolatedRecordsTableName(short)}
         WHERE scope_key = ? AND partition_key = ? AND partition_generation = ?`,
      ).bind(input.scope.key, input.partition, input.generation),
    );
  }
  batch.push(
    db.prepare(
      `DELETE FROM isolated_record_versions
       WHERE scope_key = ? AND partition_key = ? AND partition_generation = ?`,
    ).bind(input.scope.key, input.partition, input.generation),
  );
  if (batch.length) await db.batch(batch);
}

/** Purge every canonical, version, FTS, and visibility row in an isolated
 * scope. Callers should hide the scope first so this may run asynchronously. */
export async function deleteIsolatedScope(
  db: Database,
  config: ContrailConfig,
  scope: { kind: "isolated"; key: string },
): Promise<void> {
  const batch: Statement[] = [];
  for (const [short, collection] of Object.entries(config.collections)) {
    if (
      getDialect(db).ftsStrategy === "virtual-table" &&
      getSearchableFields(short, collection)?.length
    ) {
      const rows = isolatedFtsRowsTableName(short);
      const fts = isolatedFtsTableName(short);
      batch.push(
        db.prepare(
          `DELETE FROM ${fts} WHERE rowid IN (
             SELECT id FROM ${rows} WHERE scope_key = ?
           )`,
        ).bind(scope.key),
        db.prepare(`DELETE FROM ${rows} WHERE scope_key = ?`).bind(scope.key),
      );
    }
    batch.push(
      db.prepare(
        `DELETE FROM ${isolatedRecordsTableName(short)} WHERE scope_key = ?`,
      ).bind(scope.key),
    );
  }
  batch.push(
    db.prepare(`DELETE FROM isolated_record_versions WHERE scope_key = ?`).bind(scope.key),
    db.prepare(`DELETE FROM isolated_projection_partitions WHERE scope_key = ?`).bind(scope.key),
  );
  if (batch.length) await db.batch(batch);
}

export function hideIsolatedPartitionStatement(
  db: Database,
  scope: { kind: "isolated"; key: string },
  partition: string,
): Statement {
  return db.prepare(
    `DELETE FROM isolated_projection_partitions
     WHERE scope_key = ? AND partition_key = ?`,
  ).bind(scope.key, partition);
}

/** Hide one partition immediately. Record cleanup can follow asynchronously. */
export async function hideIsolatedPartition(
  db: Database,
  scope: { kind: "isolated"; key: string },
  partition: string,
): Promise<void> {
  await hideIsolatedPartitionStatement(db, scope, partition).run();
}
