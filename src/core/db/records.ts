import type {
  ContrailConfig,
  RelationConfig,
  Database,
  Statement,
  IngestEvent,
  RecordRow,
} from "../types";
import { getNestedValue, getRelationField, countColumnName } from "../types";
import { resolvedRelationsMap } from "../queryable.generated";
import { getSearchableFields, ftsTableName, buildFtsContent } from "../search";

// --- Counts ---

function getInboundRelations(
  config: ContrailConfig,
  foreignCollection: string
): RelationConfig[] {
  const results: RelationConfig[] = [];
  for (const [, colConfig] of Object.entries(config.collections)) {
    for (const [, rel] of Object.entries(colConfig.relations ?? {})) {
      if (rel.collection === foreignCollection) {
        results.push(rel);
      }
    }
  }
  return results;
}

function buildCountStatements(
  db: Database,
  event: IngestEvent,
  config: ContrailConfig
): Statement[] {
  if (event.operation !== "create" && event.operation !== "delete") return [];

  const inbound = getInboundRelations(config, event.collection);
  if (inbound.length === 0) return [];

  const record = event.record ? JSON.parse(event.record) : null;
  if (!record && event.operation === "create") return [];

  const isCreate = event.operation === "create";
  const statements: Statement[] = [];

  for (const rel of inbound) {
    const targetUri = getNestedValue(record, getRelationField(rel));
    if (!targetUri) continue;

    const columns = [countColumnName(rel.collection)];
    if (rel.groupBy) {
      const groupValue = getNestedValue(record, rel.groupBy);
      if (groupValue != null) columns.push(countColumnName(String(groupValue)));
    }

    for (const col of columns) {
      statements.push(
        db
          .prepare(
            isCreate
              ? `UPDATE records SET ${col} = ${col} + 1 WHERE uri = ?`
              : `UPDATE records SET ${col} = MAX(${col} - 1, 0) WHERE uri = ?`
          )
          .bind(targetUri)
      );
    }
  }

  return statements;
}

// --- FTS ---

function buildFtsStatements(
  db: Database,
  event: IngestEvent,
  config: ContrailConfig
): Statement[] {
  const colConfig = config.collections[event.collection];
  if (!colConfig) return [];

  const fields = getSearchableFields(event.collection, colConfig);
  if (!fields || fields.length === 0) return [];

  const table = ftsTableName(event.collection);
  const stmts: Statement[] = [];

  if (event.operation === "delete") {
    stmts.push(db.prepare(`DELETE FROM ${table} WHERE uri = ?`).bind(event.uri));
  } else {
    const record = event.record ? JSON.parse(event.record) : null;
    if (!record) return [];

    const content = buildFtsContent(record, fields);
    if (!content) return [];

    // Delete-then-insert handles both create and update
    stmts.push(db.prepare(`DELETE FROM ${table} WHERE uri = ?`).bind(event.uri));
    stmts.push(
      db.prepare(`INSERT INTO ${table} (uri, content) VALUES (?, ?)`).bind(event.uri, content)
    );
  }

  return stmts;
}

// --- Cursor ---

export async function getLastCursor(db: Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT time_us FROM cursor WHERE id = 1")
    .first<{ time_us: number }>();
  return row ? row.time_us : null;
}

export async function saveCursor(
  db: Database,
  timeUs: number
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO cursor (id, time_us) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET time_us = excluded.time_us"
    )
    .bind(timeUs)
    .run();
}

// --- Events ---

export async function applyEvents(
  db: Database,
  events: IngestEvent[],
  config?: ContrailConfig,
  options?: { skipReplayDetection?: boolean }
): Promise<void> {
  if (events.length === 0) return;

  // Look up existing records so we can skip duplicate count updates on replayed events.
  // A create/update with the same CID is a replay; a delete for a missing URI is a replay.
  // Can be skipped during backfill where records are known to be fresh inserts.
  const existingCids = new Map<string, string | null>();
  if (config && !options?.skipReplayDetection) {
    const uris = events.map((e) => e.uri);
    for (let i = 0; i < uris.length; i += 50) {
      const chunk = uris.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await db
        .prepare(`SELECT uri, cid FROM records WHERE uri IN (${placeholders})`)
        .bind(...chunk)
        .all<{ uri: string; cid: string | null }>();
      for (const row of rows.results ?? []) {
        existingCids.set(row.uri, row.cid);
      }
    }
  }

  const upsertStmt = db.prepare(
    "INSERT INTO records (uri, did, collection, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, record = excluded.record, time_us = excluded.time_us, indexed_at = excluded.indexed_at"
  );
  const deleteStmt = db.prepare("DELETE FROM records WHERE uri = ?");

  const batch: Statement[] = [];

  for (const e of events) {
    if (e.operation === "delete") {
      batch.push(deleteStmt.bind(e.uri));
    } else {
      batch.push(
        upsertStmt.bind(
          e.uri,
          e.did,
          e.collection,
          e.rkey,
          e.cid,
          e.record,
          e.time_us,
          e.indexed_at
        )
      );
    }

    if (config) {
      // Skip count updates for replayed events:
      // - create/update where the record already exists with the same CID
      // - delete where the record doesn't exist
      const existing = existingCids.get(e.uri);
      const isReplay =
        e.operation === "delete"
          ? existing === undefined
          : existing === e.cid;

      if (!isReplay) {
        batch.push(...buildCountStatements(db, e, config));
      }
      batch.push(...buildFtsStatements(db, e, config));
    }
  }

  await db.batch(batch);
}

// --- Count columns ---

function getCountColumns(config: ContrailConfig, collection: string): { type: string; column: string }[] {
  const colConfig = config.collections[collection];
  if (!colConfig?.relations) return [];
  const columns: { type: string; column: string }[] = [];
  const relMap = resolvedRelationsMap[collection] ?? {};

  for (const [relName, rel] of Object.entries(colConfig.relations)) {
    columns.push({ type: rel.collection, column: countColumnName(rel.collection) });
    const mapping = relMap[relName];
    if (mapping) {
      for (const [, fullToken] of Object.entries(mapping.groups)) {
        columns.push({ type: fullToken, column: countColumnName(fullToken) });
      }
    }
  }
  return columns;
}

// --- Query ---

export interface SortOption {
  recordField?: string;  // json path, e.g. "startsAt" — sorts by json_extract
  countType?: string;    // count type, e.g. collection NSID — sorts by aggregated count
  direction: "asc" | "desc";
}

export interface QueryOptions {
  collection: string;
  did?: string;
  limit?: number;
  cursor?: string;
  filters?: Record<string, string>;
  rangeFilters?: Record<string, { min?: string; max?: string }>;
  countFilters?: Record<string, number>;
  sort?: SortOption;
  search?: string;
}

export async function queryRecords(
  db: Database,
  config: ContrailConfig,
  options: QueryOptions
): Promise<{ records: (RecordRow & { counts?: Record<string, number> })[]; cursor?: string }> {
  const {
    collection,
    did,
    limit: rawLimit,
    cursor,
    filters = {},
    rangeFilters = {},
    countFilters = {},
    sort,
    search,
  } = options;

  const limit = Math.min(Math.max(1, rawLimit ?? 50), 200);
  const conditions: string[] = ["r.collection = ?"];
  const bindings: (string | number)[] = [collection];

  const countCols = getCountColumns(config, collection);

  if (did) {
    conditions.push("r.did = ?");
    bindings.push(did);
  }

  // Cursor = AT URI of last seen record. Look it up to get keyset values.
  if (cursor) {
    const cursorRow = await db
      .prepare("SELECT * FROM records WHERE uri = ?")
      .bind(cursor)
      .first<any>();

    if (cursorRow) {
      if (sort?.recordField) {
        const cursorRecord = cursorRow.record ? JSON.parse(cursorRow.record) : null;
        const sortValue = cursorRecord ? getNestedValue(cursorRecord, sort.recordField) : null;
        const field = `json_extract(r.record, '$.${sort.recordField}')`;
        const cmp = sort.direction === "desc" ? "<" : ">";
        conditions.push(`(${field} ${cmp} ? OR (${field} = ? AND r.time_us < ?))`);
        bindings.push(sortValue ?? "", sortValue ?? "", cursorRow.time_us);
      } else if (sort?.countType) {
        const sortCol = countColumnName(sort.countType);
        const countValue = cursorRow[sortCol] ?? 0;
        const cmp = sort.direction === "desc" ? "<" : ">";
        conditions.push(`(r.${sortCol} ${cmp} ? OR (r.${sortCol} = ? AND r.time_us < ?))`);
        bindings.push(countValue, countValue, cursorRow.time_us);
      } else {
        conditions.push("r.time_us < ?");
        bindings.push(cursorRow.time_us);
      }
    }
  }

  for (const [field, value] of Object.entries(filters)) {
    conditions.push(`json_extract(r.record, '$.${field}') = ?`);
    bindings.push(value);
  }

  for (const [field, range] of Object.entries(rangeFilters)) {
    if (range.min != null) {
      conditions.push(`json_extract(r.record, '$.${field}') >= ?`);
      bindings.push(range.min);
    }
    if (range.max != null) {
      conditions.push(`json_extract(r.record, '$.${field}') <= ?`);
      bindings.push(range.max);
    }
  }

  // Count filters — direct column comparison instead of HAVING
  for (const [type, minCount] of Object.entries(countFilters)) {
    const col = countColumnName(type);
    conditions.push(`r.${col} >= ?`);
    bindings.push(minCount);
  }

  // FTS search
  let ftsJoin = "";
  if (search) {
    const colConfig2 = config.collections[collection];
    const fields = colConfig2 ? getSearchableFields(collection, colConfig2) : null;
    if (fields && fields.length > 0) {
      const table = ftsTableName(collection);
      ftsJoin = `JOIN ${table} fts ON fts.uri = r.uri`;
      conditions.push("fts.content MATCH ?");
      bindings.push(search);
    }
  }

  const where = conditions.join(" AND ");

  // Select count columns directly
  const countSelect = countCols.length > 0
    ? ", " + countCols.map(({ column }) => `r.${column}`).join(", ")
    : "";
  const select = `r.uri, r.did, r.collection, r.rkey, r.cid, r.record, r.time_us, r.indexed_at${countSelect}`;

  const join = ftsJoin;

  let orderBy: string;
  if (sort?.recordField) {
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    orderBy = `json_extract(r.record, '$.${sort.recordField}') ${dir}, r.time_us DESC`;
  } else if (sort?.countType) {
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    const sortCol = countColumnName(sort.countType);
    orderBy = `r.${sortCol} ${dir}, r.time_us DESC`;
  } else if (ftsJoin) {
    orderBy = "fts.rank, r.time_us DESC";
  } else {
    orderBy = "r.time_us DESC";
  }

  bindings.push(limit);

  const query = `SELECT ${select} FROM records r ${join} WHERE ${where} ORDER BY ${orderBy} LIMIT ?`;

  const result = await db
    .prepare(query)
    .bind(...bindings)
    .all<any>();

  const records = (result.results ?? []).map((row: any) => {
    const rec: RecordRow & { counts?: Record<string, number> } = {
      uri: row.uri,
      did: row.did,
      collection: row.collection,
      rkey: row.rkey,
      cid: row.cid,
      record: row.record,
      time_us: row.time_us,
      indexed_at: row.indexed_at,
    };
    if (countCols.length > 0) {
      const counts: Record<string, number> = {};
      for (const { type, column } of countCols) {
        const val = row[column];
        if (val != null && val !== 0) counts[type] = val;
      }
      if (Object.keys(counts).length > 0) rec.counts = counts;
    }
    return rec;
  });

  const nextCursor =
    records.length === limit
      ? records[records.length - 1].uri
      : undefined;

  return { records, cursor: nextCursor };
}

// --- Users ---

