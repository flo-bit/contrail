import type {
  ContrailConfig,
  ResolvedContrailConfig,
  RelationConfig,
  Database,
  Statement,
  IngestEvent,
  RecordRow,
  RecordSource,
} from "../types";
import { getNestedValue, getRelationField, countColumnName, getFeedFollowCollections, recordsTableName } from "../types";
import { getSearchableFields, ftsTableName, buildFtsContent } from "../search";

// --- Counts ---

interface InboundRelation {
  parentCollection: string;
  relationName: string;
  rel: RelationConfig;
}

function getInboundRelations(
  config: ContrailConfig,
  foreignCollection: string
): InboundRelation[] {
  const results: InboundRelation[] = [];
  for (const [colName, colConfig] of Object.entries(config.collections)) {
    for (const [relName, rel] of Object.entries(colConfig.relations ?? {})) {
      if (rel.collection === foreignCollection) {
        results.push({ parentCollection: colName, relationName: relName, rel });
      }
    }
  }
  return results;
}

/**
 * Collect recount targets from a single event into a shared map.
 * The map is keyed by `parentCollection:relationName:targetValue` to deduplicate
 * across the entire batch — so 50 RSVPs to the same event produce one recount, not 50.
 */
function collectCountTargets(
  event: IngestEvent,
  config: ContrailConfig,
  existingRecordJson: string | null,
  targets: Map<string, { parentCollection: string; relationName: string; rel: RelationConfig; targetValue: string }>
): void {
  const inbound = getInboundRelations(config, event.collection);
  if (inbound.length === 0) return;

  const record = event.record ? JSON.parse(event.record) : null;
  const existingRecord = existingRecordJson ? JSON.parse(existingRecordJson) : null;

  for (const { parentCollection, relationName, rel } of inbound) {
    if (rel.count === false) continue;

    const field = getRelationField(rel);

    const values: string[] = [];
    if (record) {
      const t = getNestedValue(record, field);
      if (t) values.push(t);
    }
    if (existingRecord) {
      const t = getNestedValue(existingRecord, field);
      if (t && !values.includes(t)) values.push(t);
    }

    for (const targetValue of values) {
      const key = `${parentCollection}:${relationName}:${targetValue}`;
      if (!targets.has(key)) {
        targets.set(key, { parentCollection, relationName, rel, targetValue });
      }
    }
  }
}

/**
 * Build deduplicated count UPDATE statements from collected targets.
 * One UPDATE per unique parent+relation+target, regardless of how many
 * events in the batch affected that target.
 */
function buildBatchCountStatements(
  db: Database,
  config: ContrailConfig,
  targets: Map<string, { parentCollection: string; relationName: string; rel: RelationConfig; targetValue: string }>
): Statement[] {
  const statements: Statement[] = [];

  for (const { parentCollection, relationName, rel, targetValue } of targets.values()) {
    const field = getRelationField(rel);
    const matchColumn = rel.match === "did" ? "did" : "uri";
    const childTable = recordsTableName(rel.collection);
    const parentTable = recordsTableName(parentCollection);

    const setClauses: string[] = [];
    const setBindings: (string | number)[] = [];

    const countExpr = rel.countDistinct
      ? `COUNT(DISTINCT ${rel.countDistinct})`
      : "COUNT(*)";

    // Total count
    const totalCol = countColumnName(rel.collection);
    setClauses.push(
      `${totalCol} = (SELECT ${countExpr} FROM ${childTable} WHERE json_extract(record, '$.${field}') = ?)`
    );
    setBindings.push(targetValue);

    // Grouped counts
    if (rel.groupBy) {
      const mapping = (config as ResolvedContrailConfig)._resolved?.relations[parentCollection]?.[relationName];
      if (mapping?.groups) {
        for (const [, fullToken] of Object.entries(mapping.groups)) {
          const groupCol = countColumnName(fullToken);
          setClauses.push(
            `${groupCol} = (SELECT ${countExpr} FROM ${childTable} WHERE json_extract(record, '$.${field}') = ? AND json_extract(record, '$.${rel.groupBy}') = ?)`
          );
          setBindings.push(targetValue, fullToken);
        }
      }
    }

    if (setClauses.length > 0) {
      statements.push(
        db
          .prepare(
            `UPDATE ${parentTable} SET ${setClauses.join(", ")} WHERE ${matchColumn} = ?`
          )
          .bind(...setBindings, targetValue)
      );
    }
  }

  return statements;
}

// --- FTS ---

function buildFtsStatements(
  db: Database,
  event: IngestEvent,
  config: ContrailConfig,
  existingMap: Map<string, ExistingRecordInfo>
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

    // Only delete existing FTS row if this is an update (record already existed)
    if (existingMap.has(event.uri)) {
      stmts.push(db.prepare(`DELETE FROM ${table} WHERE uri = ?`).bind(event.uri));
    }
    stmts.push(
      db.prepare(`INSERT INTO ${table} (uri, content) VALUES (?, ?)`).bind(event.uri, content)
    );
  }

  return stmts;
}

// --- Feeds ---

function buildFeedStatements(
  db: Database,
  event: IngestEvent,
  config: ContrailConfig,
  existingRecords: Map<string, string | null>
): Statement[] {
  if (!config.feeds) return [];

  const stmts: Statement[] = [];

  for (const [, feedConfig] of Object.entries(config.feeds)) {
    const followTable = recordsTableName(feedConfig.follow);

    // Target collection: fan out to followers
    if (feedConfig.targets.includes(event.collection)) {
      if (event.operation === "create" || event.operation === "update") {
        stmts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO feed_items (actor, uri, collection, time_us)
               SELECT r.did, ?, ?, ?
               FROM ${followTable} r
               WHERE json_extract(r.record, '$.subject') = ?`
            )
            .bind(event.uri, event.collection, event.time_us, event.did)
        );
      } else if (event.operation === "delete") {
        stmts.push(
          db.prepare("DELETE FROM feed_items WHERE uri = ?").bind(event.uri)
        );
      }
    }

    // Follow collection: handle follow/unfollow
    if (event.collection === feedConfig.follow) {
      if (event.operation === "create") {
        const record = event.record ? JSON.parse(event.record) : null;
        const subject = record?.subject;
        if (subject) {
          for (const targetCol of feedConfig.targets) {
            const targetTable = recordsTableName(targetCol);
            stmts.push(
              db
                .prepare(
                  `INSERT OR IGNORE INTO feed_items (actor, uri, collection, time_us)
                   SELECT ?, r.uri, ?, r.time_us
                   FROM ${targetTable} r
                   WHERE r.did = ?
                   ORDER BY r.time_us DESC
                   LIMIT 100`
                )
                .bind(event.did, targetCol, subject)
            );
          }
        }
      } else if (event.operation === "delete") {
        const existingRecord = existingRecords.get(event.uri);
        if (existingRecord) {
          const parsed = JSON.parse(existingRecord);
          const subject = parsed?.subject;
          if (subject) {
            for (const targetCol of feedConfig.targets) {
              const targetTable = recordsTableName(targetCol);
              stmts.push(
                db
                  .prepare(
                    `DELETE FROM feed_items WHERE actor = ? AND uri IN (
                       SELECT uri FROM ${targetTable} WHERE did = ?
                     )`
                  )
                  .bind(event.did, subject)
              );
            }
          }
        }
      }
    }
  }

  return stmts;
}

// --- Feed pruning ---

export async function pruneFeedItems(
  db: Database,
  maxItems: number
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM feed_items WHERE rowid NOT IN (
         SELECT rowid FROM (
           SELECT rowid, ROW_NUMBER() OVER (PARTITION BY actor ORDER BY time_us DESC) as rn
           FROM feed_items
         ) WHERE rn <= ?
       )`
    )
    .bind(maxItems)
    .run();
  return (result as any)?.changes ?? 0;
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

// --- Existing record lookup ---

export interface ExistingRecordInfo {
  cid: string | null;
  record: string | null;
}

/**
 * Look up existing records for a set of events, grouped by collection.
 * Returns a map of uri → { cid, record }.
 * When includeRecord is false, record will always be null (saves reading large blobs).
 */
export async function lookupExistingRecords(
  db: Database,
  events: { uri: string; collection: string }[],
  includeRecord: boolean = true
): Promise<Map<string, ExistingRecordInfo>> {
  const result = new Map<string, ExistingRecordInfo>();
  if (events.length === 0) return result;

  const byCollection = new Map<string, string[]>();
  for (const e of events) {
    const uris = byCollection.get(e.collection) ?? [];
    uris.push(e.uri);
    byCollection.set(e.collection, uris);
  }

  const selectCols = includeRecord ? "uri, cid, record" : "uri, cid";
  for (const [collection, uris] of byCollection) {
    const table = recordsTableName(collection);
    for (let i = 0; i < uris.length; i += 50) {
      const chunk = uris.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await db
        .prepare(`SELECT ${selectCols} FROM ${table} WHERE uri IN (${placeholders})`)
        .bind(...chunk)
        .all<{ uri: string; cid: string | null; record?: string | null }>();
      for (const row of rows.results ?? []) {
        result.set(row.uri, {
          cid: row.cid,
          record: includeRecord ? (row.record ?? null) : null,
        });
      }
    }
  }

  return result;
}

// --- Events ---

export async function applyEvents(
  db: Database,
  events: IngestEvent[],
  config?: ContrailConfig,
  options?: {
    skipReplayDetection?: boolean;
    skipFeedFanout?: boolean;
    /** Pre-fetched existing records — skips the internal lookup when provided */
    existing?: Map<string, ExistingRecordInfo>;
  }
): Promise<void> {
  if (events.length === 0) return;

  const followCollections = config ? getFeedFollowCollections(config) : [];
  const hasCountingRelations = config ? Object.values(config.collections).some(c =>
    Object.values(c.relations ?? {}).some(r => r.count !== false)
  ) : false;
  const needRecordContent = followCollections.length > 0 || hasCountingRelations;

  // Use pre-fetched data or look up existing records
  let existingMap: Map<string, ExistingRecordInfo>;
  if (options?.existing) {
    existingMap = options.existing;
  } else if (config && !options?.skipReplayDetection) {
    existingMap = await lookupExistingRecords(db, events, needRecordContent);
  } else {
    existingMap = new Map();
  }

  const batch: Statement[] = [];

  // Build a record-content map for feed statements (needs string values)
  const existingRecordStrings = new Map<string, string | null>();
  for (const [uri, info] of existingMap) {
    existingRecordStrings.set(uri, info.record);
  }

  // Collect all count recount targets across the batch, deduplicated
  const countTargets = new Map<string, { parentCollection: string; relationName: string; rel: RelationConfig; targetValue: string }>();

  for (const e of events) {
    const table = recordsTableName(e.collection);

    if (e.operation === "delete") {
      batch.push(db.prepare(`DELETE FROM ${table} WHERE uri = ?`).bind(e.uri));
    } else {
      batch.push(
        db.prepare(
          `INSERT INTO ${table} (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, record = excluded.record, time_us = excluded.time_us, indexed_at = excluded.indexed_at`
        ).bind(
          e.uri,
          e.did,
          e.rkey,
          e.cid,
          e.record,
          e.time_us,
          e.indexed_at
        )
      );
    }

    if (config) {
      // Collect count targets (deduplicated across the whole batch)
      const existingRecordJson = existingMap.get(e.uri)?.record ?? null;
      collectCountTargets(e, config, existingRecordJson, countTargets);

      // Feed fanout still needs replay detection
      const existingInfo = existingMap.get(e.uri);
      const isReplay =
        e.operation === "delete"
          ? existingInfo === undefined
          : existingInfo?.cid === e.cid;

      if (!isReplay && !options?.skipFeedFanout) {
        batch.push(...buildFeedStatements(db, e, config, existingRecordStrings));
      }
      batch.push(...buildFtsStatements(db, e, config, existingMap));
    }
  }

  // Build deduplicated count statements — one UPDATE per unique target
  if (config) {
    batch.push(...buildBatchCountStatements(db, config, countTargets));
  }

  await db.batch(batch);
}

// --- Count columns ---

function getCountColumns(config: ContrailConfig, collection: string): { type: string; column: string }[] {
  const colConfig = config.collections[collection];
  if (!colConfig?.relations) return [];
  const columns: { type: string; column: string }[] = [];
  const relMap = (config as ResolvedContrailConfig)._resolved?.relations[collection] ?? {};

  for (const [relName, rel] of Object.entries(colConfig.relations)) {
    if (rel.count === false) continue;
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
  recordField?: string;
  countType?: string;
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
  source?: RecordSource;
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
    source,
  } = options;

  const table = recordsTableName(collection);
  const limit = Math.min(Math.max(1, rawLimit ?? 50), 200);
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (source?.conditions) conditions.push(...source.conditions);
  if (source?.params) bindings.push(...source.params);

  const countCols = getCountColumns(config, collection);

  if (did) {
    conditions.push("r.did = ?");
    bindings.push(did);
  }

  // Cursor = AT URI of last seen record. Look it up to get keyset values.
  if (cursor) {
    // Only select the columns needed for cursor pagination
    let cursorSelect: string;
    if (sort?.recordField) {
      cursorSelect = `time_us, json_extract(record, '$.${sort.recordField}') as sort_value`;
    } else if (sort?.countType) {
      const sortCol = countColumnName(sort.countType);
      cursorSelect = `time_us, ${sortCol}`;
    } else {
      cursorSelect = "time_us";
    }

    const cursorRow = await db
      .prepare(`SELECT ${cursorSelect} FROM ${table} WHERE uri = ?`)
      .bind(cursor)
      .first<any>();

    if (cursorRow) {
      if (sort?.recordField) {
        const sortValue = cursorRow.sort_value;
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
      const ftsTable = ftsTableName(collection);
      ftsJoin = `JOIN ${ftsTable} fts ON fts.uri = r.uri`;
      conditions.push("fts.content MATCH ?");
      bindings.push(search);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countSelect = countCols.length > 0
    ? ", " + countCols.map(({ column }) => `r.${column}`).join(", ")
    : "";
  const select = `r.uri, r.did, r.rkey, r.cid, r.record, r.time_us, r.indexed_at${countSelect}`;

  const join = [source?.joins, ftsJoin].filter(Boolean).join(" ");

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

  const query = `SELECT ${select} FROM ${table} r ${join} ${where} ORDER BY ${orderBy} LIMIT ?`;

  const result = await db
    .prepare(query)
    .bind(...bindings)
    .all<any>();

  const records = (result.results ?? []).map((row: any) => {
    const rec: RecordRow & { counts?: Record<string, number> } = {
      uri: row.uri,
      did: row.did,
      collection,
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

