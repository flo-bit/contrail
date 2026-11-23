import {
  JETSTREAM_V2_SEQ_THRESHOLD,
  isJetstreamTimestampCursor,
} from "../jetstream-live";
import type {
  ContrailConfig,
  Database,
  OrderedSourceConfig,
  SourcePosition,
  Statement,
} from "../types";
import {
  collectionAcquisition,
  recordsTableName,
  resolveCollectionKey,
} from "../types";
import { getDialect, isPostgresDialect } from "../dialect";

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

export const JETSTREAM_V2_SERVICE_META_KEY = "jetstream_v2_service";

/** Bind instance-local v2 seqs to one normalized service origin. A legacy
 * timestamp bridge may acquire its binding before transition; an unbound seq
 * cursor is rejected because its originating instance cannot be recovered. */
export async function assertJetstreamServiceCompatibility(
  db: Database,
  service: string,
): Promise<void> {
  let existing = await db
    .prepare("SELECT value FROM _contrail_meta WHERE key = ?")
    .bind(JETSTREAM_V2_SERVICE_META_KEY)
    .first<{ value: string }>();

  if (!existing) {
    const cursor = await getLastCursor(db);
    if (cursor !== null && !isJetstreamTimestampCursor(cursor)) {
      throw new Error(
        `durable Jetstream v2 seq cursor ${cursor} has no pinned service identity; ` +
          "rebuild or explicitly migrate the generation",
      );
    }
    await db
      .prepare(
        "INSERT INTO _contrail_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
      )
      .bind(JETSTREAM_V2_SERVICE_META_KEY, service)
      .run();
    existing = await db
      .prepare("SELECT value FROM _contrail_meta WHERE key = ?")
      .bind(JETSTREAM_V2_SERVICE_META_KEY)
      .first<{ value: string }>();
  }

  if (existing?.value !== service) {
    throw new Error(
      `configured Jetstream v2 service ${service} does not match durable service ` +
        `${existing?.value ?? "<missing>"}; seq cursors are instance-local`,
    );
  }
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
    const sourcePositionCursor = Number(existing.position.cursor);
    const liveCursor = await getLastCursor(db);
    const pendingV2Transition =
      existing.position.source === orderedSource.source &&
      Number.isSafeInteger(sourcePositionCursor) &&
      isJetstreamTimestampCursor(sourcePositionCursor) &&
      liveCursor !== null &&
      isJetstreamTimestampCursor(liveCursor);
    if (pendingV2Transition) return;
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

/** Load durable actor-acquisition scope. Identity resolution is best-effort, so
 * visible discoverable records and relay backfill rows are also authoritative
 * evidence that an actor is known. This keeps dependent collection filtering
 * stable across process restarts even when profile resolution failed. */
export async function loadKnownActorDids(
  db: Database,
  config: ContrailConfig,
): Promise<Set<string>> {
  const known = new Set<string>();
  const durableRows = await db
    .prepare(
      "SELECT did, NULL AS collection FROM identities UNION SELECT did, collection FROM backfills",
    )
    .all<{ did: string; collection: string | null }>();
  for (const row of durableRows.results ?? []) {
    const key = row.collection
      ? resolveCollectionKey(config, row.collection)
      : null;
    // Merely configuring an exact pair must not discover its publisher for
    // unrelated dependent collections. Ordinary identity evidence still counts.
    if (key && collectionAcquisition(config.collections[key]).mode === "repos")
      continue;
    known.add(row.did);
  }

  for (const [shortName, collection] of Object.entries(config.collections)) {
    if (collectionAcquisition(collection).mode !== "discover") continue;
    const rows = await db
      .prepare(`SELECT DISTINCT did FROM ${recordsTableName(shortName)}`)
      .all<{ did: string }>();
    for (const row of rows.results ?? []) known.add(row.did);
  }
  return known;
}

const KNOWN_ACTOR_LOOKUP_CHUNK = 500;

/** The subset of `dids` that `loadKnownActorDids` would contain, found with
 * one index probe per actor and source. Scheduled ingestion uses this so its
 * read cost follows the actors in a batch, not the size of the index: a
 * recycled isolate would otherwise scan every record table on each run. */
export async function lookupKnownActorDids(
  db: Database,
  config: ContrailConfig,
  dids: Iterable<string>,
): Promise<Set<string>> {
  const known = new Set<string>();
  const pending = [...new Set(dids)];
  if (pending.length === 0) return known;

  // Same exclusion as loadKnownActorDids: configuring an exact pair must not
  // make its publisher known to unrelated dependent collections.
  const scoped: string[] = [];
  const sources = ["EXISTS (SELECT 1 FROM identities WHERE did = v.value)"];
  for (const [shortName, collection] of Object.entries(config.collections)) {
    const mode = collectionAcquisition(collection).mode;
    if (mode === "repos") scoped.push(collection.collection ?? shortName);
    if (mode === "discover") {
      sources.push(
        `EXISTS (SELECT 1 FROM ${recordsTableName(shortName)} WHERE did = v.value)`,
      );
    }
  }
  sources.push(
    `EXISTS (SELECT 1 FROM backfills WHERE did = v.value${
      scoped.length
        ? ` AND collection NOT IN (${scoped.map(() => "?").join(",")})`
        : ""
    })`,
  );
  // One JSON parameter carries the whole chunk, whatever the bind limit.
  const values = isPostgresDialect(getDialect(db))
    ? "json_array_elements_text(CAST(? AS json)) AS v(value)"
    : "json_each(?) AS v";
  const sql = `SELECT v.value AS did FROM ${values} WHERE ${sources.join(" OR ")}`;

  for (
    let index = 0;
    index < pending.length;
    index += KNOWN_ACTOR_LOOKUP_CHUNK
  ) {
    const chunk = pending.slice(index, index + KNOWN_ACTOR_LOOKUP_CHUNK);
    const rows = await db
      .prepare(sql)
      .bind(JSON.stringify(chunk), ...scoped)
      .all<{ did: string }>();
    for (const row of rows.results ?? []) known.add(row.did);
  }
  return known;
}

/** Save a legacy timestamp cursor monotonically without allowing an old
 * writer to move a database that has transitioned to the v2 seq domain back
 * into the timestamp domain. */
export function saveCursorStatement(db: Database, timeUs: number): Statement {
  return db
    .prepare(
      `INSERT INTO cursor (id, time_us) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET time_us = CASE
         WHEN cursor.time_us < ${JETSTREAM_V2_SEQ_THRESHOLD}
          AND excluded.time_us >= ${JETSTREAM_V2_SEQ_THRESHOLD}
           THEN cursor.time_us
         WHEN excluded.time_us > cursor.time_us THEN excluded.time_us
         ELSE cursor.time_us
       END`,
    )
    .bind(timeUs);
}

/** Save a Jetstream v2 cursor monotonically while permitting the one-way
 * legacy timestamp -> v2 seq transition. A stale timestamp-domain writer can
 * never move an already-transitioned seq cursor back into the old domain. */
export function saveJetstreamCursorStatement(
  db: Database,
  cursor: number,
): Statement {
  return db
    .prepare(
      `INSERT INTO cursor (id, time_us) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET time_us = CASE
         WHEN cursor.time_us >= ${JETSTREAM_V2_SEQ_THRESHOLD}
          AND excluded.time_us < ${JETSTREAM_V2_SEQ_THRESHOLD}
           THEN excluded.time_us
         WHEN cursor.time_us < ${JETSTREAM_V2_SEQ_THRESHOLD}
          AND excluded.time_us >= ${JETSTREAM_V2_SEQ_THRESHOLD}
           THEN cursor.time_us
         WHEN excluded.time_us > cursor.time_us THEN excluded.time_us
         ELSE cursor.time_us
       END`,
    )
    .bind(cursor);
}

/** Legacy timestamp-domain observation hashes. V2 seqs are unique and live
 * ingestion clears these rows when it next commits; the reader remains for
 * schema/API compatibility during the transition. */
export async function getCursorObservations(
  db: Database,
  timeUs: number,
): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT observation FROM cursor_observations WHERE time_us = ?")
    .bind(timeUs)
    .all<{ observation: string }>();
  return new Set((rows.results ?? []).map((row) => row.observation));
}

function buildCursorObservationStatements(
  db: Database,
  cursor: number,
  observations: Iterable<string>,
  pruneOperator: "<" | "<>",
): Statement[] {
  return [
    db.prepare(
      `DELETE FROM cursor_observations WHERE time_us ${pruneOperator} (SELECT time_us FROM cursor WHERE id = 1)`,
    ),
    ...[...new Set(observations)].map((observation) =>
      db
        .prepare(
          "INSERT INTO cursor_observations (time_us, observation) SELECT ?, ? WHERE (SELECT time_us FROM cursor WHERE id = 1) = ? ON CONFLICT(time_us, observation) DO NOTHING",
        )
        .bind(cursor, observation, cursor),
    ),
  ];
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
  return buildCursorObservationStatements(db, timeUs, observations, "<");
}

/** V2 may move once from a large timestamp cursor to a smaller seq. Retain
 * observations only at the exact resulting cursor so timestamp-domain rows do
 * not survive that numeric decrease indefinitely. */
export function saveJetstreamCursorObservationStatements(
  db: Database,
  cursor: number,
  observations: Iterable<string>,
): Statement[] {
  return buildCursorObservationStatements(db, cursor, observations, "<>");
}

async function commitCursorBatch(
  db: Database,
  cursorStatement: Statement,
  cursor: number,
  observationStatements: Statement[],
  orderedSource?: OrderedSourceConfig,
): Promise<void> {
  const statements = [cursorStatement];
  if (orderedSource) {
    statements.push(
      saveOrderedSourcePositionStatement(db, orderedSource, cursor),
    );
  }
  statements.push(...observationStatements);
  await db.batch(statements);
}

export async function saveCursor(
  db: Database,
  timeUs: number,
  orderedSource?: OrderedSourceConfig,
  observations: Iterable<string> = [],
): Promise<void> {
  await commitCursorBatch(
    db,
    saveCursorStatement(db, timeUs),
    timeUs,
    saveCursorObservationStatements(db, timeUs, observations),
    orderedSource,
  );
}

export async function saveJetstreamCursor(
  db: Database,
  cursor: number,
  orderedSource?: OrderedSourceConfig,
  observations: Iterable<string> = [],
): Promise<void> {
  await commitCursorBatch(
    db,
    saveJetstreamCursorStatement(db, cursor),
    cursor,
    saveJetstreamCursorObservationStatements(db, cursor, observations),
    orderedSource,
  );
}
