import type {
  ContrailConfig,
  RelationConfig,
  Database,
  Statement,
  IngestEvent,
  RecordRow,
  RecordSource,
} from "../types";
import { getNestedValue, getRelationField, countColumnName, getFeedFollowCollections } from "../types";
import { resolvedRelationsMap } from "../queryable.generated";
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
 * Build statements that fully recount child records for affected parents.
 * Instead of +1/-1, we SELECT COUNT(*) so the count is always accurate.
 * This runs for create, update, and delete operations.
 */
function buildCountStatements(
  db: Database,
  event: IngestEvent,
  config: ContrailConfig,
  existingRecordJson: string | null,
): Statement[] {
  const inbound = getInboundRelations(config, event.collection);
  if (inbound.length === 0) return [];

  const record = event.record ? JSON.parse(event.record) : null;
  const existingRecord = existingRecordJson ? JSON.parse(existingRecordJson) : null;

  const statements: Statement[] = [];
  const recountedTargets = new Set<string>();

  for (const { parentCollection, relationName, rel } of inbound) {
    if (rel.count === false) continue;

    const field = getRelationField(rel);
    const matchColumn = rel.match === "did" ? "did" : "uri";
    const childCollection = rel.collection;

    // Collect target URIs/DIDs that need recounting (current + old if changed)
    const targets: string[] = [];
    if (record) {
      const t = getNestedValue(record, field);
      if (t) targets.push(t);
    }
    if (existingRecord) {
      const t = getNestedValue(existingRecord, field);
      if (t && !targets.includes(t)) targets.push(t);
    }

    for (const targetValue of targets) {
      const key = `${parentCollection}:${relationName}:${targetValue}`;
      if (recountedTargets.has(key)) continue;
      recountedTargets.add(key);

      const setClauses: string[] = [];
      const setBindings: (string | number)[] = [];

      // Total count
      const totalCol = countColumnName(rel.collection);
      setClauses.push(
        `${totalCol} = (SELECT COUNT(*) FROM records WHERE collection = ? AND json_extract(record, '$.${field}') = ?)`
      );
      setBindings.push(childCollection, targetValue);

      // Grouped counts
      if (rel.groupBy) {
        const mapping = (resolvedRelationsMap as Record<string, any>)[parentCollection]?.[relationName];
        if (mapping?.groups) {
          for (const [groupValue, fullToken] of Object.entries(mapping.groups as Record<string, string>)) {
            const groupCol = countColumnName(fullToken);
            setClauses.push(
              `${groupCol} = (SELECT COUNT(*) FROM records WHERE collection = ? AND json_extract(record, '$.${field}') = ? AND json_extract(record, '$.${rel.groupBy}') = ?)`
            );
            setBindings.push(childCollection, targetValue, groupValue);
          }
        }
      }

      if (setClauses.length > 0) {
        statements.push(
          db
            .prepare(
              `UPDATE records SET ${setClauses.join(", ")} WHERE ${matchColumn} = ?`
            )
            .bind(...setBindings, targetValue)
        );
      }
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
    // Target collection: fan out to followers
    if (feedConfig.targets.includes(event.collection)) {
      if (event.operation === "create" || event.operation === "update") {
        // Insert feed items for all followers of the event creator.
        // Follow records have: did = follower, record.subject = followed person.
        stmts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO feed_items (actor, uri, collection, time_us)
               SELECT r.did, ?, ?, ?
               FROM records r
               WHERE r.collection = ?
                 AND json_extract(r.record, '$.subject') = ?`
            )
            .bind(event.uri, event.collection, event.time_us, feedConfig.follow, event.did)
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
          // New follow: backfill recent items from the followed user
          for (const targetCol of feedConfig.targets) {
            stmts.push(
              db
                .prepare(
                  `INSERT OR IGNORE INTO feed_items (actor, uri, collection, time_us)
                   SELECT ?, r.uri, r.collection, r.time_us
                   FROM records r
                   WHERE r.collection = ? AND r.did = ?
                   ORDER BY r.time_us DESC
                   LIMIT 100`
                )
                .bind(event.did, targetCol, subject)
            );
          }
        }
      } else if (event.operation === "delete") {
        // Unfollow: remove feed items from the unfollowed user.
        // The record field is null for deletes, so we look up the existing record.
        const existingRecord = existingRecords.get(event.uri);
        if (existingRecord) {
          const parsed = JSON.parse(existingRecord);
          const subject = parsed?.subject;
          if (subject) {
            const targetPlaceholders = feedConfig.targets.map(() => "?").join(",");
            stmts.push(
              db
                .prepare(
                  `DELETE FROM feed_items WHERE actor = ? AND uri IN (
                     SELECT uri FROM records WHERE did = ? AND collection IN (${targetPlaceholders})
                   )`
                )
                .bind(event.did, subject, ...feedConfig.targets)
            );
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

// --- Events ---

export async function applyEvents(
  db: Database,
  events: IngestEvent[],
  config?: ContrailConfig,
  options?: { skipReplayDetection?: boolean; skipFeedFanout?: boolean }
): Promise<void> {
  if (events.length === 0) return;

  // Look up existing records so we can skip duplicate count updates on replayed events.
  // A create/update with the same CID is a replay; a delete for a missing URI is a replay.
  // Can be skipped during backfill where records are known to be fresh inserts.
  // Also fetches record content for follow-delete events (needed for unfollow feed cleanup).
  const existingCids = new Map<string, string | null>();
  const existingRecords = new Map<string, string | null>();
  const followCollections = config ? getFeedFollowCollections(config) : [];
  const hasCountingRelations = config ? Object.values(config.collections).some(c =>
    Object.values(c.relations ?? {}).some(r => r.count !== false)
  ) : false;
  const needRecordContent = followCollections.length > 0 || hasCountingRelations;

  if (config && !options?.skipReplayDetection) {
    const uris = events.map((e) => e.uri);
    const selectCols = needRecordContent ? "uri, cid, record" : "uri, cid";
    for (let i = 0; i < uris.length; i += 50) {
      const chunk = uris.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await db
        .prepare(`SELECT ${selectCols} FROM records WHERE uri IN (${placeholders})`)
        .bind(...chunk)
        .all<{ uri: string; cid: string | null; record?: string | null }>();
      for (const row of rows.results ?? []) {
        existingCids.set(row.uri, row.cid);
        if (needRecordContent && row.record) {
          existingRecords.set(row.uri, row.record);
        }
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
      // Recount is idempotent — always run it for create/update/delete.
      // Pass existing record so deletes and updates that change the target can recount the old parent.
      const existingRecordJson = existingRecords.get(e.uri) ?? null;
      batch.push(...buildCountStatements(db, e, config, existingRecordJson));

      // Feed fanout still needs replay detection
      const existing = existingCids.get(e.uri);
      const isReplay =
        e.operation === "delete"
          ? existing === undefined
          : existing === e.cid;

      if (!isReplay && !options?.skipFeedFanout) {
        batch.push(...buildFeedStatements(db, e, config, existingRecords));
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

  const limit = Math.min(Math.max(1, rawLimit ?? 50), 200);
  const conditions: string[] = ["r.collection = ?"];
  const bindings: (string | number)[] = [collection];

  if (source?.conditions) conditions.push(...source.conditions);
  if (source?.params) bindings.push(...source.params);

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

