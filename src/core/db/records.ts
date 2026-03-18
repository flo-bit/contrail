import type {
  ContrailConfig,
  RelationConfig,
  Database,
  Statement,
  IngestEvent,
  RecordRow,
} from "../types";
import { getNestedValue, getRelationField } from "../types";
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

    const types = [rel.collection];
    if (rel.groupBy) {
      const groupValue = getNestedValue(record, rel.groupBy);
      if (groupValue != null) types.push(String(groupValue));
    }

    for (const type of types) {
      statements.push(
        isCreate
          ? db
              .prepare(
                "INSERT INTO counts (uri, type, count) VALUES (?, ?, 1) ON CONFLICT(uri, type) DO UPDATE SET count = count + 1"
              )
              .bind(targetUri, type)
          : db
              .prepare(
                "UPDATE counts SET count = MAX(count - 1, 0) WHERE uri = ? AND type = ?"
              )
              .bind(targetUri, type)
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
  config?: ContrailConfig
): Promise<void> {
  if (events.length === 0) return;

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
      batch.push(...buildCountStatements(db, e, config));
      batch.push(...buildFtsStatements(db, e, config));
    }
  }

  await db.batch(batch);
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

  const limit = Math.min(Math.max(1, rawLimit ?? 50), 100);
  const conditions: string[] = ["r.collection = ?"];
  const bindings: (string | number)[] = [collection];

  if (did) {
    conditions.push("r.did = ?");
    bindings.push(did);
  }

  // Cursor = AT URI of last seen record. Look it up to get keyset values.
  if (cursor) {
    const cursorRow = await db
      .prepare("SELECT record, time_us FROM records WHERE uri = ?")
      .bind(cursor)
      .first<{ record: string | null; time_us: number }>();

    if (cursorRow) {
      if (sort?.recordField) {
        const cursorRecord = cursorRow.record ? JSON.parse(cursorRow.record) : null;
        const sortValue = cursorRecord ? getNestedValue(cursorRecord, sort.recordField) : null;
        const field = `json_extract(r.record, '$.${sort.recordField}')`;
        const cmp = sort.direction === "desc" ? "<" : ">";
        conditions.push(`(${field} ${cmp} ? OR (${field} = ? AND r.time_us < ?))`);
        bindings.push(sortValue ?? "", sortValue ?? "", cursorRow.time_us);
      } else if (sort?.countType) {
        // Count sort cursor — look up the count value, handled in HAVING below
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

  const colConfig = config.collections[collection];
  const relations = colConfig?.relations ?? {};
  const sortByCount = sort?.countType != null;
  const needsCounts = Object.keys(relations).length > 0 || Object.keys(countFilters).length > 0 || sortByCount;

  const countHaving: string[] = [];
  const countHavingBindings: (string | number)[] = [];
  for (const [type, minCount] of Object.entries(countFilters)) {
    countHaving.push(`COALESCE(SUM(CASE WHEN c.type = ? THEN c.count END), 0) >= ?`);
    countHavingBindings.push(type, minCount);
  }

  // Cursor condition for count sort — keyset pagination in HAVING
  if (cursor && sort?.countType) {
    const countRow = await db
      .prepare("SELECT COALESCE(count, 0) as count FROM counts WHERE uri = ? AND type = ?")
      .bind(cursor, sort.countType)
      .first<{ count: number }>();
    const cursorTimeRow = await db
      .prepare("SELECT time_us FROM records WHERE uri = ?")
      .bind(cursor)
      .first<{ time_us: number }>();

    if (cursorTimeRow) {
      const countValue = countRow?.count ?? 0;
      const countExpr = `COALESCE(SUM(CASE WHEN c.type = ? THEN c.count END), 0)`;
      const cmp = sort.direction === "desc" ? "<" : ">";
      countHaving.push(`(${countExpr} ${cmp} ? OR (${countExpr} = ? AND r.time_us < ?))`);
      countHavingBindings.push(sort.countType, countValue, sort.countType, countValue, cursorTimeRow.time_us);
    }
  }

  const where = conditions.join(" AND ");
  const select = needsCounts
    ? "r.uri, r.did, r.collection, r.rkey, r.cid, r.record, r.time_us, r.indexed_at, GROUP_CONCAT(c.type || ':' || c.count) as _counts"
    : "r.uri, r.did, r.collection, r.rkey, r.cid, r.record, r.time_us, r.indexed_at";
  const joinParts: string[] = [];
  if (ftsJoin) joinParts.push(ftsJoin);
  if (needsCounts) joinParts.push("LEFT JOIN counts c ON c.uri = r.uri");
  const join = joinParts.join(" ");
  const group = needsCounts ? "GROUP BY r.uri" : "";
  const having = countHaving.length > 0 ? `HAVING ${countHaving.join(" AND ")}` : "";

  let orderBy: string;
  const orderBindings: (string | number)[] = [];
  if (sort?.recordField) {
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    orderBy = `json_extract(r.record, '$.${sort.recordField}') ${dir}, r.time_us DESC`;
  } else if (sort?.countType) {
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    orderBy = `COALESCE(SUM(CASE WHEN c.type = ? THEN c.count END), 0) ${dir}, r.time_us DESC`;
    orderBindings.push(sort.countType);
  } else if (ftsJoin) {
    orderBy = "fts.rank, r.time_us DESC";
  } else {
    orderBy = "r.time_us DESC";
  }

  if (needsCounts) bindings.push(...countHavingBindings);
  bindings.push(...orderBindings);
  bindings.push(limit);

  const query = `SELECT ${select} FROM records r ${join} WHERE ${where} ${group} ${having} ORDER BY ${orderBy} LIMIT ?`;

  const result = await db
    .prepare(query)
    .bind(...bindings)
    .all<RecordRow & { _counts?: string }>();

  const records = (result.results ?? []).map((row) => {
    const { _counts, ...rest } = row;
    const counts = parseCounts(_counts);
    return counts ? { ...rest, counts } : rest;
  });

  const nextCursor =
    records.length === limit
      ? records[records.length - 1].uri
      : undefined;

  return { records, cursor: nextCursor };
}

function parseCounts(raw?: string | null): Record<string, number> | undefined {
  if (!raw) return undefined;
  const counts: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const sep = part.lastIndexOf(":");
    if (sep === -1) continue;
    const type = part.slice(0, sep);
    const count = parseInt(part.slice(sep + 1), 10);
    if (type && !isNaN(count)) {
      counts[type] = count;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

// --- Users ---

