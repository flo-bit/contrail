import type {
  ContrailConfig,
  ResolvedContrailConfig,
  RelationConfig,
  Database,
  Statement,
  IngestEvent,
  RecordRow,
  RecordSource,
  OrderedSourceConfig,
  ProjectionPhase,
} from "../types";
import {
  getNestedValue,
  getRelationField,
  countColumnName,
  groupedCountColumnName,
  getFeedFollowShortNames,
  recordsTableName,
  shortNameForNsid,
  resolveCollectionKey,
  nsidForShortName,
  normalizeFeedTarget,
  feedTargetMaxItems,
  DEFAULT_FOLLOW_SHORT,
  changesEnabled,
} from "../types";
import {
  getSearchableFields,
  ftsRowTableName,
  ftsTableName,
  buildFtsContent,
} from "../search";
import {
  ftsQueryClause,
  getDialect,
  sqliteFtsContentExpression,
} from "../dialect";
import type { SourcePosition } from "../sources";
import { appendChangeLogStatements } from "../change-log";

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
type CountTarget = {
  parentCollection: string;
  relationName: string;
  rel: RelationConfig;
  targetValue: string;
};

function addCountTarget(
  targets: Map<string, CountTarget>,
  target: CountTarget,
): void {
  const key = `${target.parentCollection}:${target.relationName}:${target.targetValue}`;
  if (!targets.has(key)) targets.set(key, target);
}

function collectCountTargets(
  event: IngestEvent,
  config: ContrailConfig,
  existingRecordJson: string | null,
  targets: Map<string, CountTarget>
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
      addCountTarget(targets, {
        parentCollection,
        relationName,
        rel,
        targetValue,
      });
    }
  }
}

/** Recount a newly arriving parent against children that may already exist. */
function collectParentCountTargets(
  event: IngestEvent,
  config: ContrailConfig,
  targets: Map<string, CountTarget>,
): void {
  if (event.operation === "delete") return;
  const parentCollection = shortNameForNsid(config, event.collection);
  if (!parentCollection) return;

  for (const [relationName, rel] of Object.entries(
    config.collections[parentCollection]?.relations ?? {},
  )) {
    if (rel.count === false) continue;
    addCountTarget(targets, {
      parentCollection,
      relationName,
      rel,
      targetValue: rel.match === "did" ? event.did : event.uri,
    });
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
  targets: Map<string, CountTarget>
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
  config: ContrailConfig
): Statement[] {
  // PostgreSQL: tsvector generated column is auto-maintained, no manual FTS sync
  if (getDialect(db).ftsStrategy === "generated-column") return [];

  const short = resolveCollectionKey(config, event.collection);
  if (!short) return [];
  const colConfig = config.collections[short];
  if (!colConfig) return [];

  const fields = getSearchableFields(short, colConfig);
  if (!fields || fields.length === 0) return [];

  const table = ftsTableName(short);
  const rowsTable = ftsRowTableName(short);
  const deleteFtsRow = () =>
    db
      .prepare(
        `DELETE FROM ${table} WHERE rowid = (SELECT id FROM ${rowsTable} WHERE uri = ?)`,
      )
      .bind(event.uri);
  const deleteMapping = () =>
    db.prepare(`DELETE FROM ${rowsTable} WHERE uri = ?`).bind(event.uri);

  if (event.operation === "delete") {
    return [deleteFtsRow(), deleteMapping()];
  }

  const record = event.record ? JSON.parse(event.record) : null;
  if (!record) return [];
  const content = buildFtsContent(record, fields);
  if (!content) {
    return [deleteFtsRow(), deleteMapping()];
  }

  return [
    db
      .prepare(
        `INSERT INTO ${rowsTable} (uri) VALUES (?) ON CONFLICT(uri) DO NOTHING`,
      )
      .bind(event.uri),
    deleteFtsRow(),
    db
      .prepare(
        `INSERT INTO ${table} (rowid, content) SELECT id, ? FROM ${rowsTable} WHERE uri = ?`,
      )
      .bind(content, event.uri),
  ];
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
    const followShort = feedConfig.follow ?? DEFAULT_FOLLOW_SHORT;
    const followTable = recordsTableName(followShort);
    const targets = feedConfig.targets.map(normalizeFeedTarget);
    const targetShorts = targets.map((t) => t.collection);

    // Target collection: fan out to followers
    if (targetShorts.includes(eventShort)) {
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
    if (eventShort === followShort) {
      if (event.operation === "create") {
        const record = event.record ? JSON.parse(event.record) : null;
        const subject = record?.subject;
        if (subject) {
          for (const target of targets) {
            const targetTable = recordsTableName(target.collection);
            const targetNsid = nsidForShortName(config, target.collection) ?? target.collection;
            const cap = feedTargetMaxItems(feedConfig, target);
            stmts.push(
              db
                .prepare(
                  getDialect(db).insertOrIgnore(
                    `INSERT INTO feed_items (actor, uri, collection, time_us)
                   SELECT ?, r.uri, ?, r.time_us
                   FROM ${targetTable} r
                   WHERE r.did = ?
                   ORDER BY r.time_us DESC
                   LIMIT ${cap}`
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
            for (const target of targets) {
              const targetTable = recordsTableName(target.collection);
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

/** db.batch chunk size for the sweep — caps statements per transaction. */
const SWEEP_BATCH_SIZE = 50;
/** Actor page size for the full-table {@link pruneFeedItems} recovery loop. */
const FEED_PRUNE_RECOVERY_BATCH = 200;

/**
 * Build the bounded per-actor cutoff DELETE for one (actor, collection).
 *
 * Deletes everything older than the newest `cap` rows, driven directly by
 * idx_feed_actor_coll_time(actor, collection, time_us DESC). Cost is
 * O(cap + deleted) — never O(table). This is the ONLY prune shape contrail
 * issues: an unbounded window/anti-join over the whole table can exhaust D1's
 * per-query CPU budget and reset the shared Durable Object, which kills any
 * concurrent read against the same SQLite instance.
 *
 * The cutoff is the cap-th newest row (`OFFSET cap - 1`); we delete strictly
 * older rows. Actors with `cap` or fewer rows: the OFFSET subquery yields no
 * row, the cutoff is NULL, and `time_us < NULL` matches nothing — a cheap
 * index no-op. On a tie at the cutoff time_us we keep the extra rows rather
 * than risk deleting a row we meant to keep (feed_items is a cache; a few over
 * cap is harmless, dropping a wanted item is not).
 */
function actorCutoffDelete(
  db: Database,
  actor: string,
  collection: string,
  cap: number
): Statement {
  // Plain `?` placeholders (bound repeatedly) rather than numbered params, so
  // the Postgres adapter's positional `?`→`$n` rewrite stays correct.
  return db
    .prepare(
      `DELETE FROM feed_items
         WHERE actor = ? AND collection = ?
           AND time_us < (
             SELECT time_us FROM feed_items
             WHERE actor = ? AND collection = ?
             ORDER BY time_us DESC LIMIT 1 OFFSET ?
           )`
    )
    .bind(actor, collection, actor, collection, Math.max(0, cap - 1));
}

/** Prune a single actor's feed for one collection to `cap`. Bounded O(cap). */
export async function pruneActorFeed(
  db: Database,
  actor: string,
  collection: string,
  cap: number
): Promise<number> {
  const result = await actorCutoffDelete(db, actor, collection, cap).run();
  return (result as any)?.changes ?? 0;
}

export interface FeedSweepResult {
  /** Rows deleted this slice. */
  pruned: number;
  /** Actor to resume after; null once a full pass completed (wrap to start). */
  nextCursor: string | null;
  /** True when this slice reached the end of the actor list. */
  done: boolean;
}

/**
 * One bounded slice of a rolling feed-items prune.
 *
 * Pages at most `actorBudget` distinct actors (resuming after `cursor`, via the
 * feed_items (actor, uri) PK) and applies the per-(actor, collection) cutoff
 * delete for every cap in `caps`. Every issued statement is index-backed and
 * O(cap), so the slice's per-query CPU stays flat no matter how large
 * feed_items grows — the property the old global window query lacked.
 *
 * Drive it across ticks with a persisted cursor (see getFeedPruneCursor):
 * feed back `nextCursor` until `done`, at which point the cursor wraps to null
 * and the next pass starts from the beginning. Because each pass visits every
 * actor, this doubles as the recovery path for an already-bloated table.
 */
export async function sweepFeedItems(
  db: Database,
  caps: Map<string, number>,
  cursor: string | null,
  actorBudget: number
): Promise<FeedSweepResult> {
  if (caps.size === 0 || actorBudget <= 0) {
    return { pruned: 0, nextCursor: null, done: true };
  }

  const actorsRes = cursor
    ? await db
        .prepare(
          "SELECT DISTINCT actor FROM feed_items WHERE actor > ? ORDER BY actor LIMIT ?"
        )
        .bind(cursor, actorBudget)
        .all<{ actor: string }>()
    : await db
        .prepare("SELECT DISTINCT actor FROM feed_items ORDER BY actor LIMIT ?")
        .bind(actorBudget)
        .all<{ actor: string }>();

  const actors = (actorsRes.results ?? []).map((r) => r.actor);
  if (actors.length === 0) {
    // Ran off the end (cursor pointed past the last actor) — wrap next tick.
    return { pruned: 0, nextCursor: null, done: true };
  }

  const stmts: Statement[] = [];
  for (const actor of actors) {
    for (const [collection, cap] of caps) {
      stmts.push(actorCutoffDelete(db, actor, collection, cap));
    }
  }

  let pruned = 0;
  for (let i = 0; i < stmts.length; i += SWEEP_BATCH_SIZE) {
    const results = await db.batch(stmts.slice(i, i + SWEEP_BATCH_SIZE));
    for (const r of results) pruned += (r as any)?.changes ?? 0;
  }

  // A short page means we exhausted the actor list this slice.
  const done = actors.length < actorBudget;
  return { pruned, nextCursor: done ? null : actors[actors.length - 1], done };
}

/**
 * Prune the ENTIRE feed_items table to the per-collection `caps` by looping the
 * bounded {@link sweepFeedItems} until a full pass completes.
 *
 * Every statement is O(cap) and safe against D1's per-query CPU limit, but the
 * statement count is O(distinct actors), so keep this OFF the hot ingest path —
 * the cron/persistent loops issue a single bounded slice per tick instead. Use
 * it for one-shot recovery or admin tooling.
 */
export async function pruneFeedItems(
  db: Database,
  caps: Map<string, number>
): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const res = await sweepFeedItems(db, caps, cursor, FEED_PRUNE_RECOVERY_BATCH);
    total += res.pruned;
    if (res.done) break;
    cursor = res.nextCursor;
  }
  return total;
}

// --- Feed prune cursor ---

/** Last actor swept by the rolling feed prune; null = start of a fresh pass. */
export async function getFeedPruneCursor(db: Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT actor FROM feed_prune_cursor WHERE id = 1")
    .first<{ actor: string | null }>();
  return row?.actor ?? null;
}

export async function saveFeedPruneCursor(
  db: Database,
  actor: string | null
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO feed_prune_cursor (id, actor) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET actor = excluded.actor"
    )
    .bind(actor)
    .run();
}

// --- Cursor and ordered source position ---

export interface ServingSourcePosition {
  position: SourcePosition;
  updatedAt: number;
}

export async function getServingSourcePosition(
  db: Database,
): Promise<ServingSourcePosition | null> {
  const row = await db
    .prepare(
      "SELECT source, epoch, cursor, updated_at FROM source_position WHERE id = 1",
    )
    .first<{
      source: string;
      epoch: string;
      cursor: string;
      updated_at: number;
    }>();
  return row
    ? {
        position: {
          source: row.source,
          epoch: row.epoch,
          cursor: row.cursor,
        },
        updatedAt: Number(row.updated_at),
      }
    : null;
}

export function saveServingSourcePositionStatement(
  db: Database,
  position: SourcePosition,
  updatedAt = Date.now(),
): Statement {
  return db
    .prepare(
      `INSERT INTO source_position (id, source, epoch, cursor, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source = excluded.source,
         epoch = excluded.epoch,
         cursor = excluded.cursor,
         updated_at = excluded.updated_at`,
    )
    .bind(position.source, position.epoch, position.cursor, updatedAt);
}

export async function assertServingSourceCompatibility(
  db: Database,
  orderedSource?: OrderedSourceConfig,
): Promise<void> {
  if (!orderedSource) return;
  let existing = await getServingSourcePosition(db);
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO source_position (id, source, epoch, cursor, updated_at)
         SELECT 1, ?, ?, CAST(time_us AS TEXT), ? FROM cursor WHERE id = 1
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(orderedSource.source, orderedSource.epoch, Date.now())
      .run();
    existing = await getServingSourcePosition(db);
    if (!existing) return;
  }
  if (
    existing.position.source !== orderedSource.source ||
    existing.position.epoch !== orderedSource.epoch
  ) {
    throw new Error(
      `configured ordered source ${orderedSource.source}/${orderedSource.epoch} ` +
        `does not match durable source position ` +
        `${existing.position.source}/${existing.position.epoch}`,
    );
  }
}

export function orderedSourcePosition(
  orderedSource: OrderedSourceConfig,
  cursor: number | string,
): SourcePosition {
  return {
    source: orderedSource.source,
    epoch: orderedSource.epoch,
    cursor: String(cursor),
  };
}

export function saveOrderedSourcePositionStatement(
  db: Database,
  orderedSource: OrderedSourceConfig,
  timeUs: number,
  updatedAt = Date.now(),
): Statement {
  const position = orderedSourcePosition(orderedSource, timeUs);
  return db
    .prepare(
      `INSERT INTO source_position (id, source, epoch, cursor, updated_at)
       SELECT 1, ?, ?, ?, ?
       WHERE (SELECT time_us FROM cursor WHERE id = 1) = ?
       ON CONFLICT(id) DO UPDATE SET
         source = excluded.source,
         epoch = excluded.epoch,
         cursor = excluded.cursor,
         updated_at = excluded.updated_at`,
    )
    .bind(
      position.source,
      position.epoch,
      position.cursor,
      updatedAt,
      timeUs,
    );
}

export async function getLastCursor(db: Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT time_us FROM cursor WHERE id = 1")
    .first<{ time_us: number }>();
  return row ? row.time_us : null;
}

export function saveCursorStatement(
  db: Database,
  timeUs: number,
): Statement {
  return db
    .prepare(
      "INSERT INTO cursor (id, time_us) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET time_us = CASE WHEN excluded.time_us > cursor.time_us THEN excluded.time_us ELSE cursor.time_us END",
    )
    .bind(timeUs);
}

/** Exact source observations already accounted for at the current coarse
 * cursor. Scheduled Jetstream resumes one microsecond earlier and uses these
 * hashes to avoid both skipping same-cursor siblings and recounting prior ones. */
export async function getCursorObservations(
  db: Database,
  timeUs: number,
): Promise<Set<string>> {
  const rows = await db
    .prepare(
      "SELECT observation FROM cursor_observations WHERE time_us = ?",
    )
    .bind(timeUs)
    .all<{ observation: string }>();
  return new Set((rows.results ?? []).map((row) => row.observation));
}

/** Statements that atomically retire observations behind the monotonic cursor
 * and union observations accounted for at its current timestamp. Inserts are
 * conditional so an older concurrent cycle cannot attach hashes to a newer
 * checkpoint. */
export function saveCursorObservationStatements(
  db: Database,
  timeUs: number,
  observations: Iterable<string>,
): Statement[] {
  return [
    db.prepare(
      "DELETE FROM cursor_observations WHERE time_us < (SELECT time_us FROM cursor WHERE id = 1)",
    ),
    ...[...new Set(observations)].map((observation) =>
      db
        .prepare(
          "INSERT INTO cursor_observations (time_us, observation) SELECT ?, ? WHERE (SELECT time_us FROM cursor WHERE id = 1) = ? ON CONFLICT(time_us, observation) DO NOTHING",
        )
        .bind(timeUs, observation, timeUs),
    ),
  ];
}

export async function saveCursor(
  db: Database,
  timeUs: number,
  orderedSource?: OrderedSourceConfig,
  observations: Iterable<string> = [],
): Promise<void> {
  const statements = [saveCursorStatement(db, timeUs)];
  if (orderedSource) {
    statements.push(
      saveOrderedSourcePositionStatement(db, orderedSource, timeUs),
    );
  }
  statements.push(...saveCursorObservationStatements(db, timeUs, observations));
  await db.batch(statements);
}

// --- Existing record lookup ---

export interface ExistingRecordInfo {
  cid: string | null;
  record: string | null;
  /** When the row was last written to our DB (microseconds). Populated
   *  whenever `lookupExistingRecords` runs, regardless of `includeRecord`. */
  indexed_at: number | null;
}

export interface RecordVersionInfo {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  operation: "create" | "update" | "delete";
  cid: string | null;
  source_id: string;
  source_epoch: string | null;
  source_revision: string | null;
  source_time_us: number;
  source_cursor: string | null;
  indexed_at: number;
  /** Opaque optimistic-concurrency token; not part of source ordering. */
  projection_token: string;
}

type ComparableRecordVersion = Omit<RecordVersionInfo, "projection_token">;

function versionForEvent(event: IngestEvent): ComparableRecordVersion {
  const source = event.source;
  return {
    uri: event.uri,
    did: event.did,
    collection: event.collection,
    rkey: event.rkey,
    operation: event.operation,
    cid: event.cid,
    source_id: source?.id ?? "legacy-caller",
    source_epoch: source?.epoch ?? null,
    // Before 0.13.1 callers had no separate source clock, so time_us is the
    // least surprising compatibility fallback for hand-built IngestEvents.
    source_time_us: source?.time_us ?? event.time_us,
    source_revision: source?.revision ?? null,
    source_cursor: source?.cursor ?? null,
    indexed_at: event.indexed_at,
  };
}

function comparePositionStrings(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function operationRank(operation: RecordVersionInfo["operation"]): number {
  if (operation === "delete") return 3;
  if (operation === "update") return 2;
  return 1;
}

/**
 * Compare two observations of one canonical URI. Repository revisions are the
 * strongest signal when both sides have one. Otherwise source event/observation
 * time orders adapters consistently. Remaining comparisons are deterministic
 * tie-breakers; notably a delete wins an exact tie so replay cannot resurrect it.
 */
export function compareRecordVersions(
  left: ComparableRecordVersion,
  right: ComparableRecordVersion,
): number {
  if (
    left.source_revision !== null &&
    right.source_revision !== null &&
    left.source_revision !== right.source_revision
  ) {
    return comparePositionStrings(left.source_revision, right.source_revision);
  }
  if (left.source_time_us !== right.source_time_us) {
    return left.source_time_us < right.source_time_us ? -1 : 1;
  }
  if ((left.source_revision === null) !== (right.source_revision === null)) {
    return left.source_revision === null ? -1 : 1;
  }
  if (
    left.source_id === right.source_id &&
    left.source_epoch === right.source_epoch &&
    left.source_cursor !== null &&
    right.source_cursor !== null &&
    left.source_cursor !== right.source_cursor
  ) {
    return comparePositionStrings(left.source_cursor, right.source_cursor);
  }
  const operationDifference =
    operationRank(left.operation) - operationRank(right.operation);
  if (operationDifference !== 0) return operationDifference;
  const leftCid = left.cid ?? "";
  const rightCid = right.cid ?? "";
  if (leftCid !== rightCid) return leftCid < rightCid ? -1 : 1;
  if (left.source_id !== right.source_id) {
    return left.source_id < right.source_id ? -1 : 1;
  }
  const leftEpoch = left.source_epoch ?? "";
  const rightEpoch = right.source_epoch ?? "";
  if (leftEpoch !== rightEpoch) return leftEpoch < rightEpoch ? -1 : 1;
  return 0;
}

export async function lookupRecordVersions(
  db: Database,
  uris: Iterable<string>,
): Promise<Map<string, RecordVersionInfo>> {
  const uniqueUris = [...new Set(uris)];
  const versions = new Map<string, RecordVersionInfo>();
  for (let index = 0; index < uniqueUris.length; index += 50) {
    const chunk = uniqueUris.slice(index, index + 50);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT uri, did, collection, rkey, operation, cid, source_id, source_epoch, source_revision, source_time_us, source_cursor, indexed_at, projection_token FROM record_versions WHERE uri IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<RecordVersionInfo>();
    for (const row of rows.results ?? []) versions.set(row.uri, row);
  }
  return versions;
}

export interface MutationSelection {
  applied: IngestEvent[];
  superseded: number;
}

export function selectMutationWinners(
  events: IngestEvent[],
  durable: ReadonlyMap<string, RecordVersionInfo>,
): MutationSelection {
  const winners = new Map<
    string,
    { event: IngestEvent; version: ComparableRecordVersion; index: number }
  >();
  let superseded = 0;

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const version = versionForEvent(event);
    const batchWinner = winners.get(event.uri);
    const current = batchWinner?.version ?? durable.get(event.uri);
    if (current && compareRecordVersions(version, current) <= 0) {
      superseded++;
      continue;
    }
    if (batchWinner) superseded++;
    winners.set(event.uri, { event, version, index });
  }

  return {
    applied: [...winners.values()]
      .sort((left, right) => left.index - right.index)
      .map((winner) => winner.event),
    superseded,
  };
}

/** Deduplicate one authoritative source observation without a durable lookup. */
export function selectAuthoritativeMutations(
  events: IngestEvent[],
): MutationSelection {
  return selectMutationWinners(events, new Map());
}

/** Select one newest mutation per URI and reject rows older than durable state. */
export async function selectCurrentMutations(
  db: Database,
  events: IngestEvent[],
): Promise<MutationSelection> {
  if (events.length === 0) return { applied: [], superseded: 0 };
  const durable = await lookupRecordVersions(db, events.map((event) => event.uri));
  return selectMutationWinners(events, durable);
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
    const short = config ? resolveCollectionKey(config, e.collection) : e.collection;
    if (!short) continue;
    const uris = byShort.get(short) ?? [];
    uris.push(e.uri);
    byShort.set(short, uris);
  }

  const selectCols = includeRecord ? "uri, cid, record, indexed_at" : "uri, cid, indexed_at";
  for (const [short, uris] of byShort) {
    const table = recordsTableName(short);
    for (let i = 0; i < uris.length; i += 50) {
      const chunk = uris.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await db
        .prepare(`SELECT ${selectCols} FROM ${table} WHERE uri IN (${placeholders})`)
        .bind(...chunk)
        .all<{
          uri: string;
          cid: string | null;
          record?: string | null;
          indexed_at: number | null;
        }>();
      for (const row of rows.results ?? []) {
        result.set(row.uri, {
          cid: row.cid,
          record: includeRecord ? (row.record ?? null) : null,
          indexed_at: row.indexed_at ?? null,
        });
      }
    }
  }

  return result;
}

// --- Events ---

// D1 accepts at most 100 bound parameters per statement. A record upsert uses
// seven, so fourteen rows fit while leaving the same SQL valid for SQLite and
// PostgreSQL. Packing rows avoids one prepared statement per record during
// backfill without changing the admission or derived-projection path.
const MAX_STATEMENT_BINDINGS = 100;
const RECORD_UPSERT_BINDINGS = 7;
const RECORD_UPSERT_ROWS = Math.floor(
  MAX_STATEMENT_BINDINGS / RECORD_UPSERT_BINDINGS
);
const RECORD_VERSION_BINDINGS = 13;
const RECORD_VERSION_ROWS = Math.floor(
  MAX_STATEMENT_BINDINGS / RECORD_VERSION_BINDINGS,
);
const PROJECTION_GUARD_URIS = 40;

interface StorageMutation {
  event: IngestEvent;
  table: string;
}

function buildRecordVersionStatements(
  db: Database,
  events: IngestEvent[],
  existing: Map<string, ExistingRecordInfo>,
  projectionTokens: ReadonlyMap<string, string>,
): Statement[] {
  const statements: Statement[] = [];
  for (let index = 0; index < events.length; index += RECORD_VERSION_ROWS) {
    const chunk = events.slice(index, index + RECORD_VERSION_ROWS);
    const values = chunk
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO record_versions (uri, did, collection, rkey, operation, cid, source_id, source_epoch, source_revision, source_time_us, source_cursor, indexed_at, projection_token) VALUES ${values} ON CONFLICT(uri) DO UPDATE SET did = excluded.did, collection = excluded.collection, rkey = excluded.rkey, operation = excluded.operation, cid = excluded.cid, source_id = excluded.source_id, source_epoch = excluded.source_epoch, source_revision = excluded.source_revision, source_time_us = excluded.source_time_us, source_cursor = excluded.source_cursor, indexed_at = excluded.indexed_at, projection_token = excluded.projection_token`,
        )
        .bind(
          ...chunk.flatMap((event) => {
            const version = versionForEvent(event);
            const retainedCid =
              event.operation === "delete"
                ? (version.cid ?? existing.get(event.uri)?.cid ?? null)
                : version.cid;
            return [
              version.uri,
              version.did,
              version.collection,
              version.rkey,
              version.operation,
              retainedCid,
              version.source_id,
              version.source_epoch,
              version.source_revision,
              version.source_time_us,
              version.source_cursor,
              version.indexed_at,
              projectionTokens.get(event.uri)!,
            ];
          }),
        ),
    );
  }
  return statements;
}

function buildRecordMutationStatements(
  db: Database,
  mutations: Iterable<StorageMutation>
): Statement[] {
  const byTable = new Map<
    string,
    { upserts: IngestEvent[]; deletes: IngestEvent[] }
  >();
  for (const { event, table } of mutations) {
    const group = byTable.get(table) ?? { upserts: [], deletes: [] };
    if (event.operation === "delete") group.deletes.push(event);
    else group.upserts.push(event);
    byTable.set(table, group);
  }

  const statements: Statement[] = [];
  for (const [table, { upserts, deletes }] of byTable) {
    for (let index = 0; index < upserts.length; index += RECORD_UPSERT_ROWS) {
      const chunk = upserts.slice(index, index + RECORD_UPSERT_ROWS);
      const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
      statements.push(
        db
          .prepare(
            `INSERT INTO ${table} (uri, did, rkey, cid, record, time_us, indexed_at) VALUES ${values} ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, record = excluded.record, time_us = excluded.time_us, indexed_at = excluded.indexed_at`
          )
          .bind(
            ...chunk.flatMap((event) => [
              event.uri,
              event.did,
              event.rkey,
              event.cid,
              event.record,
              event.time_us,
              event.indexed_at,
            ])
          )
      );
    }

    for (let index = 0; index < deletes.length; index += MAX_STATEMENT_BINDINGS) {
      const chunk = deletes.slice(index, index + MAX_STATEMENT_BINDINGS);
      const placeholders = chunk.map(() => "?").join(", ");
      statements.push(
        db
          .prepare(`DELETE FROM ${table} WHERE uri IN (${placeholders})`)
          .bind(...chunk.map((event) => event.uri))
      );
    }
  }
  return statements;
}

function buildProjectionGuardStatements(
  db: Database,
  events: IngestEvent[],
  predecessors: ReadonlyMap<string, RecordVersionInfo>,
): Statement[] {
  const uris = [...new Set(events.map((event) => event.uri))];
  const statements: Statement[] = [
    db.prepare(
      `INSERT INTO _contrail_projection_state (id, revision, guard)
       VALUES (1, 0, 1) ON CONFLICT(id) DO NOTHING`,
    ),
    // PostgreSQL takes a row lock here. The following statement then receives a
    // fresh READ COMMITTED snapshot after any earlier projector commits. SQLite
    // and D1 already serialize the containing write batch.
    db.prepare(
      `UPDATE _contrail_projection_state
       SET revision = revision + 1
       WHERE id = 1`,
    ),
  ];
  for (let index = 0; index < uris.length; index += PROJECTION_GUARD_URIS) {
    const chunk = uris.slice(index, index + PROJECTION_GUARD_URIS);
    const conditions: string[] = [];
    const bindings: string[] = [];
    for (const uri of chunk) {
      const predecessor = predecessors.get(uri);
      if (!predecessor) {
        conditions.push(
          "NOT EXISTS (SELECT 1 FROM record_versions WHERE uri = ?)",
        );
        bindings.push(uri);
        continue;
      }
      if (!predecessor.projection_token) {
        throw new Error(`Record version ${uri} has no projection token`);
      }
      conditions.push(
        "EXISTS (SELECT 1 FROM record_versions WHERE uri = ? AND projection_token = ?)",
      );
      bindings.push(uri, predecessor.projection_token);
    }
    statements.push(
      db
        .prepare(
          `UPDATE _contrail_projection_state
           SET guard = CASE WHEN ${conditions.join(" AND ")} THEN 1 ELSE 0 END
           WHERE id = 1`,
        )
        .bind(...bindings),
    );
  }
  return statements;
}

/** Adapter-neutral classification for the named optimistic guard constraint. */
export function isProjectionConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return (
    (candidate.code === "23514" &&
      candidate.constraint === "projection_guard_valid") ||
    /projection_guard_valid/i.test(String(candidate.message ?? ""))
  );
}

export async function projectEvents(
  db: Database,
  events: IngestEvent[],
  config: ContrailConfig,
  options?: {
    skipReplayDetection?: boolean;
    skipFeedFanout?: boolean;
    /** Skip FTS and relation-count maintenance during canonical bulk loading. */
    skipDerivedProjections?: boolean;
    /** @deprecated Existing rows are re-read for transaction conflict safety. */
    existing?: Map<string, ExistingRecordInfo>;
    /** Statements committed after projection in the same database batch. */
    trailingStatements?: Statement[];
    /** Internal: ingestRecords already checked durable source order. */
    sourceOrderingChecked?: boolean;
    /** Durable versions observed while selecting source winners. */
    predecessors?: ReadonlyMap<string, RecordVersionInfo>;
    /** Acquisition phase persisted on an optional change batch. */
    phase?: ProjectionPhase;
  },
): Promise<MutationSelection> {
  if (events.length === 0) return { applied: [], superseded: 0 };

  const predecessors =
    options?.predecessors ??
    (await lookupRecordVersions(db, events.map((event) => event.uri)));
  const selection = options?.sourceOrderingChecked
    ? { applied: events, superseded: 0 }
    : selectMutationWinners(events, predecessors);
  events = selection.applied;
  if (events.length === 0) {
    if (options?.trailingStatements?.length) {
      await db.batch(options.trailingStatements);
    }
    return selection;
  }

  const followCollections = getFeedFollowShortNames(config);
  const hasCountingRelations =
    !options?.skipDerivedProjections &&
    Object.values(config.collections).some((collection) =>
      Object.values(collection.relations ?? {}).some(
        (relation) => relation.count !== false
      )
    );
  const needRecordContent =
    followCollections.length > 0 ||
    hasCountingRelations ||
    changesEnabled(config);

  // Existing state must be read after predecessor selection. A caller-provided
  // map can predate that selection and would make derived changes incorrect
  // even when the optimistic token guard itself succeeds.
  const needExistingState =
    !options?.skipReplayDetection || needRecordContent || changesEnabled(config);
  const existingMap = needExistingState
    ? await lookupExistingRecords(db, events, needRecordContent, config)
    : new Map<string, ExistingRecordInfo>();

  const batch: Statement[] = [];
  // Keep only the final storage mutation for a URI within this atomic batch.
  // Derived projections still inspect every admitted event below.
  const storageMutations = new Map<string, StorageMutation>();

  // Build a record-content map for feed statements (needs string values)
  const existingRecordStrings = new Map<string, string | null>();
  for (const [uri, info] of existingMap) {
    existingRecordStrings.set(uri, info.record);
  }

  // Collect all count recount targets across the batch, deduplicated
  const countTargets = new Map<string, CountTarget>();

  for (const e of events) {
    // Event's collection is an NSID. Resolve its storage key from config.
    const short = resolveCollectionKey(config, e.collection);
    if (!short) {
      (config.logger ?? console).warn(
        `[ingest] drop (unknown collection in projection): ${e.operation} ${e.uri} collection=${e.collection}`
      );
      continue;
    }
    const table = recordsTableName(short);
    storageMutations.set(`${table}\0${e.uri}`, { event: e, table });

    if (!options?.skipDerivedProjections) {
      // Collect count targets (deduplicated across the whole batch)
      const existingRecordJson = existingMap.get(e.uri)?.record ?? null;
      collectCountTargets(e, config, existingRecordJson, countTargets);
      collectParentCountTargets(e, config, countTargets);
    }

    // Feed fanout still needs replay detection
    const existingInfo = existingMap.get(e.uri);
    const isReplay =
      e.operation === "delete"
        ? existingInfo === undefined
        : existingInfo?.cid === e.cid;

    if (!isReplay && !options?.skipFeedFanout) {
      batch.push(...buildFeedStatements(db, e, config, existingRecordStrings));
    }
    if (!options?.skipDerivedProjections) {
      batch.push(...buildFtsStatements(db, e, config));
    }
  }

  const projectionTokens = new Map(
    events.map((event) => [event.uri, crypto.randomUUID()] as const),
  );

  // Lock, verify the exact durable predecessors selected by the caller, then
  // write storage and version metadata. Any changed token violates the named
  // guard constraint and rolls the complete database batch back.
  batch.unshift(
    ...buildProjectionGuardStatements(db, events, predecessors),
    ...buildRecordMutationStatements(db, storageMutations.values()),
    ...buildRecordVersionStatements(
      db,
      events,
      existingMap,
      projectionTokens,
    ),
  );

  // Build deduplicated count statements, then append the compact change batch.
  // Caller-provided source checkpoints deliberately remain last.
  batch.push(...buildBatchCountStatements(db, config, countTargets));
  batch.push(
    ...appendChangeLogStatements(
      db,
      events,
      existingMap,
      config,
      options?.phase ?? "live",
    ),
  );
  if (options?.trailingStatements?.length) {
    batch.push(...options.trailingStatements);
  }

  await db.batch(batch);
  return selection;
}

/** Rebuild projections that are intentionally skipped during canonical bulk
 * loading. Live ingestion and scheduled retries continue maintaining them
 * incrementally after this set-based catch-up. */
export async function rebuildDerivedProjections(
  db: Database,
  config: ContrailConfig
): Promise<void> {
  const dialect = getDialect(db);

  if (dialect.ftsStrategy === "virtual-table") {
    for (const [short, collection] of Object.entries(config.collections)) {
      const fields = getSearchableFields(short, collection);
      if (!fields || fields.length === 0) continue;

      const ftsTable = ftsTableName(short);
      const rowsTable = ftsRowTableName(short);
      const recordsTable = recordsTableName(short);
      const content = sqliteFtsContentExpression(fields);
      try {
        await db.batch([
          db.prepare(`DELETE FROM ${ftsTable}`),
          db.prepare(`DELETE FROM ${rowsTable}`),
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
        ]);
      } catch {
        // FTS5 is optional in some SQLite builds, matching schema initialization.
      }
    }
  }

  const countStatements: Statement[] = [];
  for (const [parentShort, parentConfig] of Object.entries(config.collections)) {
    const parentTable = recordsTableName(parentShort);
    for (const [relationName, relation] of Object.entries(
      parentConfig.relations ?? {}
    )) {
      if (relation.count === false) continue;

      const childTable = recordsTableName(relation.collection);
      const childTarget = dialect.jsonExtract(
        "child.record",
        getRelationField(relation)
      );
      const parentTarget = relation.match === "did" ? "did" : "uri";
      const distinctExpression = relation.countDistinct
        ? ["uri", "did", "rkey"].includes(relation.countDistinct)
          ? `child.${relation.countDistinct}`
          : dialect.jsonExtract("child.record", relation.countDistinct)
        : null;
      const totalCount = distinctExpression
        ? `COUNT(DISTINCT ${distinctExpression})`
        : "COUNT(*)";
      const totalColumn = countColumnName(relation.collection);
      const projections = [`${totalCount} AS ${totalColumn}`];
      const columns = [totalColumn];
      const bindings: string[] = [];

      const mapping = (config as ResolvedContrailConfig)._resolved?.relations[
        parentShort
      ]?.[relationName];
      if (relation.groupBy && mapping?.groups) {
        const childGroup = dialect.jsonExtract(
          "child.record",
          relation.groupBy
        );
        for (const [groupKey, token] of Object.entries(mapping.groups)) {
          const column = groupedCountColumnName(
            relation.collection,
            groupKey
          );
          const groupedCount = distinctExpression
            ? `COUNT(DISTINCT CASE WHEN ${childGroup} = ? THEN ${distinctExpression} END)`
            : `SUM(CASE WHEN ${childGroup} = ? THEN 1 ELSE 0 END)`;
          projections.push(`${groupedCount} AS ${column}`);
          columns.push(column);
          bindings.push(token);
        }
      }

      // Reset parents with no matching children, then update only parents that
      // appear in one grouped child scan. This avoids N parents × M correlated
      // COUNT subqueries during a historical rebuild.
      countStatements.push(
        db.prepare(
          `UPDATE ${parentTable} SET ${columns
            .map((column) => `${column} = 0`)
            .join(", ")}`
        )
      );
      const aggregateUpdate = db.prepare(
        `WITH derived AS (
           SELECT ${childTarget} AS target, ${projections.join(", ")}
           FROM ${childTable} child
           GROUP BY ${childTarget}
         )
         UPDATE ${parentTable} AS parent
         SET ${columns
           .map((column) => `${column} = derived.${column}`)
           .join(", ")}
         FROM derived
         WHERE parent.${parentTarget} = derived.target`
      );
      countStatements.push(
        bindings.length > 0
          ? aggregateUpdate.bind(...bindings)
          : aggregateUpdate
      );
    }
  }

  if (countStatements.length > 0) await db.batch(countStatements);
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

/** Opaque keyset cursor. `v` is the primary sort value, `t` is time,
 *  and `u` is the final unique tiebreaker. */
interface CursorPayload {
  t: number;
  u: string;
  v?: string | number | null;
  k: "time" | "search" | string;
}

function sortKind(sort?: SortOption): "time" | string {
  if (sort?.recordField) return `field:${sort.recordField}`;
  if (sort?.countType) return `count:${sort.countType}`;
  return "time";
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeCursor(payload: CursorPayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const p = JSON.parse(decodeBase64Url(cursor));
    if (
      typeof p?.t !== "number" ||
      typeof p?.u !== "string" ||
      typeof p?.k !== "string"
    ) {
      return null;
    }
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
  } = options;

  // Accept either the short name (canonical) or the full NSID for convenience.
  const collection =
    config.collections[collectionInput]
      ? collectionInput
      : shortNameForNsid(config, collectionInput) ?? collectionInput;

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

  const dialect = getDialect(db);
  let ftsJoin = "";
  let ftsClause: ReturnType<typeof ftsQueryClause> | null = null;
  if (search) {
    const collectionConfig = config.collections[collection];
    const fields = collectionConfig
      ? getSearchableFields(collection, collectionConfig)
      : null;
    if (fields && fields.length > 0) {
      ftsClause = ftsQueryClause(dialect, recordsTableName(collection));
      ftsJoin = ftsClause.join;
      conditions.push(ftsClause.condition);
      bindings.push(search);
    }
  }

  // Cursors are accepted only for the ordering that created them. URI is the
  // final key so rows with identical sort values and timestamps cannot vanish.
  const expectedKind = sort
    ? sortKind(sort)
    : ftsClause
      ? "search"
      : "time";
  if (cursor) {
    const payload = decodeCursor(cursor);
    if (payload && payload.k === expectedKind) {
      const stableTail =
        "(r.time_us < ? OR (r.time_us = ? AND r.uri > ?))";
      if (sort?.recordField) {
        const sortExpr = dialect.jsonExtract("r.record", sort.recordField);
        if (payload.v === null) {
          conditions.push(`(${sortExpr} IS NULL AND ${stableTail})`);
          bindings.push(payload.t, payload.t, payload.u);
        } else if (payload.v !== undefined) {
          const cmp = sort.direction === "desc" ? "<" : ">";
          conditions.push(
            `(${sortExpr} ${cmp} ? OR (${sortExpr} = ? AND ${stableTail}) OR ${sortExpr} IS NULL)`,
          );
          bindings.push(
            payload.v,
            payload.v,
            payload.t,
            payload.t,
            payload.u,
          );
        }
      } else if (sort?.countType) {
        const sortCol = countColumnForType(config, collection, sort.countType);
        if (!sortCol) throw new Error(`Unknown countType: ${sort.countType}`);
        const cmp = sort.direction === "desc" ? "<" : ">";
        const value = Number(payload.v ?? 0);
        conditions.push(
          `(r.${sortCol} ${cmp} ? OR (r.${sortCol} = ? AND ${stableTail}))`,
        );
        bindings.push(value, value, payload.t, payload.t, payload.u);
      } else if (ftsClause && search && typeof payload.v === "number") {
        const rankExpr = ftsClause.orderExpr;
        const cmp = ftsClause.orderDirection === "desc" ? "<" : ">";
        conditions.push(
          `(${rankExpr} ${cmp} ? OR (${rankExpr} = ? AND ${stableTail}))`,
        );
        if (dialect.ftsStrategy === "generated-column") {
          bindings.push(
            search,
            payload.v,
            search,
            payload.v,
            payload.t,
            payload.t,
            payload.u,
          );
        } else {
          bindings.push(
            payload.v,
            payload.v,
            payload.t,
            payload.t,
            payload.u,
          );
        }
      } else if (!ftsClause) {
        conditions.push(stableTail);
        bindings.push(payload.t, payload.t, payload.u);
      }
    }
  }

  for (const [field, value] of Object.entries(filters)) {
    conditions.push(`${dialect.jsonExtract("r.record", field)} = ?`);
    bindings.push(value);
  }

  for (const [field, range] of Object.entries(rangeFilters)) {
    if (range.min != null) {
      conditions.push(`${dialect.jsonExtract("r.record", field)} >= ?`);
      bindings.push(range.min);
    }
    if (range.max != null) {
      conditions.push(`${dialect.jsonExtract("r.record", field)} <= ?`);
      bindings.push(range.max);
    }
  }

  for (const [type, minCount] of Object.entries(countFilters)) {
    const col = countColumnForType(config, collection, type);
    if (!col) continue; // unknown count type — skip filter
    conditions.push(`r.${col} >= ?`);
    bindings.push(minCount);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countSelect = countCols.length > 0
    ? ", " + countCols.map(({ column }) => `r.${column}`).join(", ")
    : "";
  const selectBindings: (string | number)[] = [];
  const fieldSortSelect = sort?.recordField
    ? `, ${dialect.jsonExtract("r.record", sort.recordField)} AS __sort_value`
    : "";
  let searchRankSelect = "";
  if (expectedKind === "search" && ftsClause && search) {
    searchRankSelect = `, ${ftsClause.orderExpr} AS __search_rank`;
    if (dialect.ftsStrategy === "generated-column") {
      selectBindings.push(search);
    }
  }
  const select = `r.uri, r.did, r.rkey, r.cid, r.record, r.time_us, r.indexed_at${countSelect}${fieldSortSelect}${searchRankSelect}`;

  const join = [source?.joins, ftsJoin].filter(Boolean).join(" ");
  const orderBindings: (string | number)[] = [];

  let orderBy: string;
  if (sort?.recordField) {
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    orderBy = `${dialect.jsonExtract("r.record", sort.recordField)} ${dir} NULLS LAST, r.time_us DESC, r.uri ASC`;
  } else if (sort?.countType) {
    const dir = sort.direction === "desc" ? "DESC" : "ASC";
    const sortCol = countColumnForType(config, collection, sort.countType);
    if (!sortCol) throw new Error(`Unknown countType: ${sort.countType}`);
    orderBy = `r.${sortCol} ${dir}, r.time_us DESC, r.uri ASC`;
  } else if (ftsClause) {
    const dir = ftsClause.orderDirection.toUpperCase();
    orderBy = `${ftsClause.orderExpr} ${dir}, r.time_us DESC, r.uri ASC`;
    if (dialect.ftsStrategy === "generated-column" && search) {
      orderBindings.push(search);
    }
  } else {
    orderBy = "r.time_us DESC, r.uri ASC";
  }

  const query = `SELECT ${select} FROM ${table} r ${join} ${where} ORDER BY ${orderBy} LIMIT ?`;

  const result = await db
    .prepare(query)
    .bind(...selectBindings, ...bindings, ...orderBindings, limit)
    .all<any>();
  const rows = result.results ?? [];

  const nsid = nsidForShortName(config, collection) ?? collection;
  const records = rows.map((row: any) => {
    const rec: RecordRow & { counts?: Record<string, number> } = {
      uri: row.uri,
      did: row.did,
      collection: nsid,
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
      ? buildCursor(
          records[records.length - 1],
          sort,
          expectedKind,
          rows[rows.length - 1]?.__sort_value,
          rows[rows.length - 1]?.__search_rank,
        )
      : undefined;

  return { records, cursor: nextCursor };
}

/** Build an opaque keyset cursor from the last row of a page. */
function buildCursor(
  row: RecordRow & { counts?: Record<string, number> },
  sort: SortOption | undefined,
  kind: string,
  fieldSortValue?: unknown,
  searchRank?: unknown,
): string {
  const t = Number(row.time_us);
  const u = row.uri;
  if (sort?.recordField) {
    const v =
      fieldSortValue === null ||
      typeof fieldSortValue === "string" ||
      typeof fieldSortValue === "number"
        ? fieldSortValue
        : null;
    return encodeCursor({ t, u, v, k: kind });
  }
  if (sort?.countType) {
    const v = row.counts?.[sort.countType] ?? 0;
    return encodeCursor({ t, u, v, k: kind });
  }
  if (kind === "search") {
    const v = Number(searchRank);
    if (!Number.isFinite(v)) throw new Error("Search rank missing from result");
    return encodeCursor({ t, u, v, k: kind });
  }
  return encodeCursor({ t, u, k: kind });
}
