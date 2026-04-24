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
import {
  getNestedValue,
  getRelationField,
  countColumnName,
  groupedCountColumnName,
  getFeedFollowShortNames,
  recordsTableName,
  spacesRecordsTableName,
  shortNameForNsid,
  nsidForShortName,
} from "../types";
import { getSearchableFields, ftsTableName, buildFtsContent } from "../search";
import { ftsQueryClause, getDialect } from "../dialect";

// --- Counts ---

interface InboundRelation {
  /** Short name of the parent collection. */
  parentCollection: string;
  relationName: string;
  rel: RelationConfig;
}

/** Find relations that target the given short-named child collection. */
function getInboundRelations(
  config: ContrailConfig,
  childShortName: string
): InboundRelation[] {
  const results: InboundRelation[] = [];
  for (const [colName, colConfig] of Object.entries(config.collections)) {
    for (const [relName, rel] of Object.entries(colConfig.relations ?? {})) {
      if (rel.collection === childShortName) {
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
  const childShort = shortNameForNsid(config, event.collection);
  if (!childShort) return;
  const inbound = getInboundRelations(config, childShort);
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
      `${totalCol} = (SELECT ${countExpr} FROM ${childTable} WHERE ${getDialect(db).jsonExtract('record', field)} = ?)`
    );
    setBindings.push(targetValue);

    // Grouped counts — column names are `count_<child-short>_<group-key>`; match
    // against the group's full token value in the record.
    if (rel.groupBy) {
      const mapping = (config as ResolvedContrailConfig)._resolved?.relations[parentCollection]?.[relationName];
      if (mapping?.groups) {
        for (const [groupKey, fullToken] of Object.entries(mapping.groups)) {
          const groupCol = groupedCountColumnName(rel.collection, groupKey);
          setClauses.push(
            `${groupCol} = (SELECT ${countExpr} FROM ${childTable} WHERE ${getDialect(db).jsonExtract('record', field)} = ? AND ${getDialect(db).jsonExtract('record', rel.groupBy)} = ?)`
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
  // PostgreSQL: tsvector generated column is auto-maintained, no manual FTS sync
  if (getDialect(db).ftsStrategy === "generated-column") return [];

  const short = shortNameForNsid(config, event.collection);
  if (!short) return [];
  const colConfig = config.collections[short];
  if (!colConfig) return [];

  const fields = getSearchableFields(short, colConfig);
  if (!fields || fields.length === 0) return [];

  const table = ftsTableName(short);
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

  const eventShort = shortNameForNsid(config, event.collection);
  if (!eventShort) return [];

  for (const [, feedConfig] of Object.entries(config.feeds)) {
    const followTable = recordsTableName(feedConfig.follow);

    // Target collection: fan out to followers
    if (feedConfig.targets.includes(eventShort)) {
      if (event.operation === "create" || event.operation === "update") {
        stmts.push(
          db
            .prepare(
              getDialect(db).insertOrIgnore(
                `INSERT INTO feed_items (actor, uri, collection, time_us)
               SELECT r.did, ?, ?, ?
               FROM ${followTable} r
               WHERE ${getDialect(db).jsonExtract('r.record', 'subject')} = ?`
              )
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
    if (eventShort === feedConfig.follow) {
      if (event.operation === "create") {
        const record = event.record ? JSON.parse(event.record) : null;
        const subject = record?.subject;
        if (subject) {
          for (const targetShort of feedConfig.targets) {
            const targetTable = recordsTableName(targetShort);
            const targetNsid = nsidForShortName(config, targetShort) ?? targetShort;
            stmts.push(
              db
                .prepare(
                  getDialect(db).insertOrIgnore(
                    `INSERT INTO feed_items (actor, uri, collection, time_us)
                   SELECT ?, r.uri, ?, r.time_us
                   FROM ${targetTable} r
                   WHERE r.did = ?
                   ORDER BY r.time_us DESC
                   LIMIT 100`
                  )
                )
                .bind(event.did, targetNsid, subject)
            );
          }
        }
      } else if (event.operation === "delete") {
        const existingRecord = existingRecords.get(event.uri);
        if (existingRecord) {
          const parsed = JSON.parse(existingRecord);
          const subject = parsed?.subject;
          if (subject) {
            for (const targetShort of feedConfig.targets) {
              const targetTable = recordsTableName(targetShort);
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
      `DELETE FROM feed_items WHERE (actor, uri) NOT IN (
         SELECT actor, uri FROM (
           SELECT actor, uri, ROW_NUMBER() OVER (PARTITION BY actor ORDER BY time_us DESC) as rn
           FROM feed_items
         ) sub WHERE rn <= ?
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
  includeRecord: boolean = true,
  config?: ContrailConfig
): Promise<Map<string, ExistingRecordInfo>> {
  const result = new Map<string, ExistingRecordInfo>();
  if (events.length === 0) return result;

  // Group by short name (config lookup); skip events for collections not in our config.
  const byShort = new Map<string, string[]>();
  for (const e of events) {
    const short = config ? shortNameForNsid(config, e.collection) : e.collection;
    if (!short) continue;
    const uris = byShort.get(short) ?? [];
    uris.push(e.uri);
    byShort.set(short, uris);
  }

  const selectCols = includeRecord ? "uri, cid, record" : "uri, cid";
  for (const [short, uris] of byShort) {
    const table = recordsTableName(short);
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
    /** When provided, publish `collection:<nsid>` and `actor:<did>` realtime
     *  events for each applied event. Space-scoped publishing happens elsewhere
     *  (see `realtime/publishing-adapter.ts`); public topics carry public
     *  records only, which is exactly the scope of this function. */
    pubsub?: import("../realtime/types").PubSub;
  }
): Promise<void> {
  if (events.length === 0) return;

  const followCollections = config ? getFeedFollowShortNames(config) : [];
  const hasCountingRelations = config ? Object.values(config.collections).some(c =>
    Object.values(c.relations ?? {}).some(r => r.count !== false)
  ) : false;
  const needRecordContent = followCollections.length > 0 || hasCountingRelations;

  // Use pre-fetched data or look up existing records
  let existingMap: Map<string, ExistingRecordInfo>;
  if (options?.existing) {
    existingMap = options.existing;
  } else if (config && !options?.skipReplayDetection) {
    existingMap = await lookupExistingRecords(db, events, needRecordContent, config);
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
    // Event's collection is an NSID. Look up the short name from config.
    // If no config or not found, treat collection string as-is (for tests that pre-populate tables).
    const short = config
      ? shortNameForNsid(config, e.collection) ?? (config.collections[e.collection] ? e.collection : null)
      : e.collection;
    if (!short) {
      (config?.logger ?? console).warn(
        `[ingest] drop (unknown collection in applyEvents): ${e.operation} ${e.uri} collection=${e.collection}`
      );
      continue;
    }
    const table = recordsTableName(short);

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

  // Publish realtime events for public records (collection: and actor:).
  // Space records publish via the wrapping adapter; this path is public-only.
  if (options?.pubsub) {
    const pubsub = options.pubsub;
    const ts = Date.now();
    for (const e of events) {
      if (e.operation === "delete") {
        const payload = {
          uri: e.uri,
          did: e.did,
          collection: e.collection,
          rkey: e.rkey,
        };
        await pubsub.publish({ topic: `collection:${e.collection}`, kind: "record.deleted", payload, ts });
        await pubsub.publish({ topic: `actor:${e.did}`, kind: "record.deleted", payload, ts });
      } else {
        const record = e.record ? safeParseJson(e.record) : {};
        const payload = {
          uri: e.uri,
          did: e.did,
          collection: e.collection,
          rkey: e.rkey,
          cid: e.cid,
          record,
          time_us: e.time_us,
        };
        await pubsub.publish({ topic: `collection:${e.collection}`, kind: "record.created", payload, ts });
        await pubsub.publish({ topic: `actor:${e.did}`, kind: "record.created", payload, ts });
      }
    }
  }
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// --- Count columns ---

/** Count column descriptor. `type` is the identifier returned in API responses and
 *  accepted in countFilters — we keep the full record token for grouped counts so
 *  callers pass e.g. "community.lexicon.calendar.rsvp#going" and filter/hydrate by it. */
function getCountColumns(
  config: ContrailConfig,
  shortName: string
): { type: string; column: string }[] {
  const colConfig = config.collections[shortName];
  if (!colConfig?.relations) return [];
  const columns: { type: string; column: string }[] = [];
  const relMap = (config as ResolvedContrailConfig)._resolved?.relations[shortName] ?? {};

  for (const [relName, rel] of Object.entries(colConfig.relations)) {
    if (rel.count === false) continue;
    // Total: identifier is the child's short name; column is `count_<child-short>`.
    columns.push({ type: rel.collection, column: countColumnName(rel.collection) });
    const mapping = relMap[relName];
    if (mapping) {
      for (const [groupKey, fullToken] of Object.entries(mapping.groups)) {
        // Grouped: identifier is the full record token (stable across deployments);
        // column is `count_<child-short>_<group-key>`.
        columns.push({
          type: fullToken,
          column: groupedCountColumnName(rel.collection, groupKey),
        });
      }
    }
  }
  return columns;
}

/** For a given "count type" (short name or full group token), return the DB column. */
function countColumnForType(
  config: ContrailConfig,
  shortName: string,
  type: string
): string | null {
  for (const col of getCountColumns(config, shortName)) {
    if (col.type === type) return col.column;
  }
  return null;
}

// --- Query ---

export interface SortOption {
  recordField?: string;
  countType?: string;
  direction: "asc" | "desc";
}

/** Opaque keyset cursor. `t` is the tiebreaker (time_us of the last row),
 *  `v` is the sort-key value (string for record fields, number for counts),
 *  `k` identifies the sort so we can reject mismatched cursors. */
interface CursorPayload {
  t: number;
  v?: string | number;
  k: "time" | string; // "time" | `field:<name>` | `count:<type>`
}

function sortKind(sort?: SortOption): "time" | string {
  if (sort?.recordField) return `field:${sort.recordField}`;
  if (sort?.countType) return `count:${sort.countType}`;
  return "time";
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const p = JSON.parse(json);
    if (typeof p?.t !== "number" || typeof p?.k !== "string") return null;
    return p as CursorPayload;
  } catch {
    return null;
  }
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
  /** When set, query the per-space table (`spaces_records_<short>`) instead of the
   *  public `records_<short>` table, scoped to rows where `space_uri = ?`. */
  spaceUri?: string;
}

export async function queryRecords(
  db: Database,
  config: ContrailConfig,
  options: QueryOptions
): Promise<{ records: (RecordRow & { counts?: Record<string, number> })[]; cursor?: string }> {
  const {
    collection: collectionInput,
    did,
    limit: rawLimit,
    cursor,
    filters = {},
    rangeFilters = {},
    countFilters = {},
    sort,
    search,
    source,
    spaceUri,
  } = options;

  // Accept either the short name (canonical) or the full NSID for convenience.
  const collection =
    config.collections[collectionInput]
      ? collectionInput
      : shortNameForNsid(config, collectionInput) ?? collectionInput;

  const table = spaceUri ? spacesRecordsTableName(collection) : recordsTableName(collection);
  const limit = Math.min(Math.max(1, rawLimit ?? 50), 200);
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (spaceUri) {
    conditions.push("r.space_uri = ?");
    bindings.push(spaceUri);
  }

  if (source?.conditions) conditions.push(...source.conditions);
  if (source?.params) bindings.push(...source.params);

  const countCols = getCountColumns(config, collection);

  if (did) {
    conditions.push("r.did = ?");
    bindings.push(did);
  }

  // Opaque keyset cursor encoding { t, v?, k }. Silently ignored if it doesn't
  // match the current sort — callers shouldn't mix sort params with stale cursors.
  const expectedKind = sortKind(sort);
  if (cursor) {
    const payload = decodeCursor(cursor);
    if (payload && payload.k === expectedKind) {
      if (sort?.recordField) {
        const sortExpr = getDialect(db).jsonExtract('r.record', sort.recordField);
        const cmp = sort.direction === "desc" ? "<" : ">";
        conditions.push(`(${sortExpr} ${cmp} ? OR (${sortExpr} = ? AND r.time_us < ?))`);
        const v = payload.v ?? "";
        bindings.push(v as string | number, v as string | number, payload.t);
      } else if (sort?.countType) {
        const sortCol = countColumnForType(config, collection, sort.countType);
        if (!sortCol) throw new Error(`Unknown countType: ${sort.countType}`);
        const cmp = sort.direction === "desc" ? "<" : ">";
        conditions.push(`(r.${sortCol} ${cmp} ? OR (r.${sortCol} = ? AND r.time_us < ?))`);
        const v = Number(payload.v ?? 0);
        bindings.push(v, v, payload.t);
      } else {
        conditions.push("r.time_us < ?");
        bindings.push(payload.t);
      }
    }
  }

  for (const [field, value] of Object.entries(filters)) {
    conditions.push(`${getDialect(db).jsonExtract('r.record', field)} = ?`);
    bindings.push(value);
  }

  for (const [field, range] of Object.entries(rangeFilters)) {
    if (range.min != null) {
      conditions.push(`${getDialect(db).jsonExtract('r.record', field)} >= ?`);
      bindings.push(range.min);
    }
    if (range.max != null) {
      conditions.push(`${getDialect(db).jsonExtract('r.record', field)} <= ?`);
      bindings.push(range.max);
    }
  }

  for (const [type, minCount] of Object.entries(countFilters)) {
    const col = countColumnForType(config, collection, type);
    if (!col) continue; // unknown count type — skip filter
    conditions.push(`r.${col} >= ?`);
    bindings.push(minCount);
  }

  // FTS search. Not supported in space mode yet (would need composite keying
  // because the same at-URI can appear in multiple spaces).
  let ftsJoin = "";
  let ftsClause: ReturnType<typeof ftsQueryClause> | null = null;
  if (search && !spaceUri) {
    const colConfig2 = config.collections[collection];
    const fields = colConfig2 ? getSearchableFields(collection, colConfig2) : null;
    if (fields && fields.length > 0) {
      ftsClause = ftsQueryClause(getDialect(db), recordsTableName(collection));
      ftsJoin = ftsClause.join;
      conditions.push(ftsClause.condition);
      // SECURITY: `search` is user input bound as a parameter, not interpolated.
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
    orderBy = `${getDialect(db).jsonExtract('r.record', sort.recordField)} ${dir}, r.time_us DESC`;
  } else if (sort?.countType) {
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    const sortCol = countColumnForType(config, collection, sort.countType);
    if (!sortCol) throw new Error(`Unknown countType: ${sort.countType}`);
    orderBy = `r.${sortCol} ${dir}, r.time_us DESC`;
  } else if (ftsClause) {
    orderBy = `${ftsClause.orderExpr}, r.time_us DESC`;
    // PG ts_rank needs the search term bound again for ORDER BY
    if (getDialect(db).ftsStrategy === "generated-column" && search) {
      bindings.push(search);
    }
  } else {
    orderBy = "r.time_us DESC";
  }

  bindings.push(limit);

  const query = `SELECT ${select} FROM ${table} r ${join} ${where} ORDER BY ${orderBy} LIMIT ?`;

  const result = await db
    .prepare(query)
    .bind(...bindings)
    .all<any>();

  const nsid = nsidForShortName(config, collection) ?? collection;
  const records = (result.results ?? []).map((row: any) => {
    const rec: RecordRow & { counts?: Record<string, number> } = {
      uri: row.uri,
      did: row.did,
      collection: nsid,
      rkey: row.rkey,
      cid: row.cid,
      record: row.record,
      time_us: row.time_us,
      indexed_at: row.indexed_at,
      ...(spaceUri ? { _space: spaceUri } : {}),
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
      ? buildCursor(records[records.length - 1], sort, expectedKind)
      : undefined;

  return { records, cursor: nextCursor };
}

/** Build an opaque keyset cursor from the last row of a page. */
function buildCursor(
  row: RecordRow & { counts?: Record<string, number> },
  sort: SortOption | undefined,
  kind: string
): string {
  const t = Number(row.time_us);
  if (sort?.recordField) {
    const parsed = row.record ? JSON.parse(row.record) : null;
    const v = parsed ? getNestedValue(parsed, sort.recordField) : undefined;
    return encodeCursor({ t, v: v == null ? "" : String(v), k: kind });
  }
  if (sort?.countType) {
    const v = row.counts?.[sort.countType] ?? 0;
    return encodeCursor({ t, v, k: kind });
  }
  return encodeCursor({ t, k: kind });
}

/** Compare two rows according to the active sort order. Returns negative if
 *  `a` should come before `b`, positive otherwise. Matches the SQL ORDER BY. */
function compareRows(
  a: RecordRow & { counts?: Record<string, number> },
  b: RecordRow & { counts?: Record<string, number> },
  sort: SortOption | undefined
): number {
  const timeCmp = Number(b.time_us) - Number(a.time_us); // time_us DESC
  if (sort?.recordField) {
    const ar = a.record ? JSON.parse(a.record) : null;
    const br = b.record ? JSON.parse(b.record) : null;
    const av = ar ? getNestedValue(ar, sort.recordField) : undefined;
    const bv = br ? getNestedValue(br, sort.recordField) : undefined;
    const dir = sort.direction === "desc" ? -1 : 1;
    const cmp = (av === bv ? 0 : (av! < bv! ? -1 : 1)) * dir;
    return cmp !== 0 ? cmp : timeCmp;
  }
  if (sort?.countType) {
    const av = a.counts?.[sort.countType] ?? 0;
    const bv = b.counts?.[sort.countType] ?? 0;
    const dir = sort.direction === "desc" ? -1 : 1;
    const cmp = (av === bv ? 0 : (av < bv ? -1 : 1)) * dir;
    return cmp !== 0 ? cmp : timeCmp;
  }
  return timeCmp;
}

/** Run a listRecords query across the public table and a set of per-space tables
 *  in parallel, then merge according to the active sort order. The cursor is a
 *  shared keyset cursor — every sub-query applies the same `WHERE` keyset, so
 *  pagination is consistent across sources. */
export async function queryAcrossSources(
  db: Database,
  config: ContrailConfig,
  options: QueryOptions,
  spaceUris: string[]
): Promise<{ records: (RecordRow & { counts?: Record<string, number> })[]; cursor?: string }> {
  if (spaceUris.length === 0) {
    return queryRecords(db, config, options);
  }
  const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
  const perSourceLimit = limit; // each source fetches up to `limit`; we trim after merge

  const tasks: Promise<{ records: (RecordRow & { counts?: Record<string, number> })[] }>[] = [
    queryRecords(db, config, { ...options, limit: perSourceLimit }),
  ];
  for (const spaceUri of spaceUris) {
    tasks.push(queryRecords(db, config, { ...options, spaceUri, limit: perSourceLimit }));
  }
  const results = await Promise.all(tasks);
  const merged = results.flatMap((r) => r.records);
  merged.sort((a, b) => compareRows(a, b, options.sort));
  const trimmed = merged.slice(0, limit);
  const kind = sortKind(options.sort);
  const cursor =
    trimmed.length === limit ? buildCursor(trimmed[trimmed.length - 1], options.sort, kind) : undefined;
  return { records: trimmed, cursor };
}

// --- Users ---

