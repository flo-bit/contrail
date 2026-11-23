import type {
  ContrailConfig,
  Database,
  IngestEvent,
  ProjectionPhase,
  RelationConfig,
  Statement,
} from "../types";
import {
  changesEnabled,
  getFeedFollowShortNames,
  recordsTableName,
  resolveCollectionKey,
} from "../types";
import {
  buildFtsContent,
  ftsRowTableName,
  ftsTableName,
  getSearchableFields,
} from "../search";
import {
  getDialect,
  isPostgresDialect,
  sqliteFtsContentExpression,
} from "../dialect";
import { appendChangeLogStatements } from "../change-log";
import {
  actionProjectionStatements,
  labelBackfillEnqueueStatements,
  visibleRecordSql,
} from "../moderation";
import {
  buildBatchCountStatements,
  buildRelationRebuildSpec,
  collectCountTargets,
  collectParentCountTargets,
  type CountTarget,
} from "./counts";
import { buildFeedStatements } from "./feeds";
import {
  MAX_STATEMENT_BINDINGS,
  buildProjectionGuardStatements,
  buildRecordVersionStatements,
  chunkJsonArrayRows,
  lookupExistingRecords,
  lookupRecordVersions,
  selectAuthoritativeMutations,
  selectMutationWinners,
  type ExistingRecordInfo,
  type MutationSelection,
  type RecordVersionInfo,
} from "./versions";

const RECORD_UPSERT_BINDINGS = 7;
const RECORD_UPSERT_ROWS = Math.floor(
  MAX_STATEMENT_BINDINGS / RECORD_UPSERT_BINDINGS,
);

interface StorageMutation {
  event: IngestEvent;
  table: string;
}

function buildFtsStatements(
  db: Database,
  event: IngestEvent,
  config: ContrailConfig,
  getRecord?: () => unknown,
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

  const record = getRecord
    ? getRecord()
    : event.record
      ? JSON.parse(event.record)
      : null;
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

/** Populate `fts_*_rows` and `fts_*` from a collection's record table (full
 * table when `uriRange` is omitted, or bounded `[firstUri, lastUri]` slice). */
export function populateVirtualFtsStatements(
  db: Database,
  collection: string,
  fields: string[],
  uriRange?: { firstUri: string; lastUri: string },
): Statement[] {
  const recordsTable = recordsTableName(collection);
  const ftsTable = ftsTableName(collection);
  const rowsTable = ftsRowTableName(collection);
  const content = sqliteFtsContentExpression(fields);
  const rangeFilter = uriRange ? " WHERE uri >= ? AND uri <= ?" : "";
  const insertRows = db.prepare(
    `INSERT INTO ${rowsTable} (uri)
     SELECT uri FROM (
       SELECT uri, ${content} AS content FROM ${recordsTable}${rangeFilter}
     ) rebuilt
     WHERE content <> ''
     ORDER BY uri`,
  );
  const insertFts = db.prepare(
    `INSERT INTO ${ftsTable} (rowid, content)
     SELECT fts_rows.id, rebuilt.content
     FROM (
       SELECT uri, ${content} AS content FROM ${recordsTable}${rangeFilter}
     ) rebuilt
     JOIN ${rowsTable} fts_rows ON fts_rows.uri = rebuilt.uri
     WHERE rebuilt.content <> ''`,
  );
  return uriRange
    ? [
        insertRows.bind(uriRange.firstUri, uriRange.lastUri),
        insertFts.bind(uriRange.firstUri, uriRange.lastUri),
      ]
    : [insertRows, insertFts];
}

function buildRecordMutationStatements(
  db: Database,
  mutations: Iterable<StorageMutation>,
  useJsonBulk = false,
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
    if (useJsonBulk && upserts.length > 1) {
      const payloads = chunkJsonArrayRows(
        upserts.map((event) => [
          event.uri,
          event.did,
          event.rkey,
          event.cid,
          event.record,
          event.time_us,
          event.indexed_at,
        ]),
      );
      for (const payload of payloads) {
        statements.push(
          db
            .prepare(
              `INSERT INTO ${table} (uri, did, rkey, cid, record, time_us, indexed_at)
               SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
                      json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]'),
                      json_extract(j.value, '$[6]')
               FROM json_each(?) AS j
               WHERE true
               ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, record = excluded.record, time_us = excluded.time_us, indexed_at = excluded.indexed_at`,
            )
            .bind(payload),
        );
      }
    } else {
      for (let index = 0; index < upserts.length; index += RECORD_UPSERT_ROWS) {
        const chunk = upserts.slice(index, index + RECORD_UPSERT_ROWS);
        const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
        statements.push(
          db
            .prepare(
              `INSERT INTO ${table} (uri, did, rkey, cid, record, time_us, indexed_at) VALUES ${values} ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, record = excluded.record, time_us = excluded.time_us, indexed_at = excluded.indexed_at`,
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
              ]),
            ),
        );
      }
    }

    for (
      let index = 0;
      index < deletes.length;
      index += MAX_STATEMENT_BINDINGS
    ) {
      const chunk = deletes.slice(index, index + MAX_STATEMENT_BINDINGS);
      const placeholders = chunk.map(() => "?").join(", ");
      statements.push(
        db
          .prepare(`DELETE FROM ${table} WHERE uri IN (${placeholders})`)
          .bind(...chunk.map((event) => event.uri)),
      );
    }
  }
  return statements;
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
    /** @internal Fast path strictly for fresh unpublished single-writer bulk
     * loads (such as Alluvium export bootstrap). Skips pre-insert version and
     * existing-record SELECT lookups and per-URI `_contrail_projection_state`
     * guard statements so each batch commits in a single `db.batch()` call. */
    freshBulkLoad?: boolean;
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

  const freshBulk = options?.freshBulkLoad === true;
  const predecessors =
    options?.predecessors ??
    (freshBulk
      ? new Map<string, RecordVersionInfo>()
      : await lookupRecordVersions(
          db,
          events.map((event) => event.uri),
        ));
  const selection = options?.sourceOrderingChecked
    ? { applied: events, superseded: 0 }
    : freshBulk
      ? selectAuthoritativeMutations(events)
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
        (relation) => relation.count !== false,
      ),
    );
  const needRecordContent =
    followCollections.length > 0 ||
    hasCountingRelations ||
    changesEnabled(config);

  // Existing state must be read after predecessor selection. A caller-provided
  // map can predate that selection and would make derived changes incorrect
  // even when the optimistic token guard itself succeeds.
  const needExistingState =
    !freshBulk &&
    (!options?.skipReplayDetection ||
      needRecordContent ||
      changesEnabled(config));
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
        `[ingest] drop (unknown collection in projection): ${e.operation} ${e.uri} collection=${e.collection}`,
      );
      continue;
    }
    const table = recordsTableName(short);
    storageMutations.set(`${table}\0${e.uri}`, { event: e, table });

    // Feed fanout still needs replay detection
    const existingInfo = existingMap.get(e.uri);
    const isReplay =
      e.operation === "delete"
        ? existingInfo === undefined
        : existingInfo?.cid === e.cid;

    const runDerived = !options?.skipDerivedProjections;
    const runFeed = !isReplay && !options?.skipFeedFanout && !!config.feeds;
    // Lazily parse event.record on first consumer demand: zero parses when no
    // consumer needs the JSON body, and at most one parse when multiple do.
    let parsed = false;
    let cachedRecord: unknown = null;
    const getRecord = () => {
      if (!parsed) {
        cachedRecord = e.record ? JSON.parse(e.record) : null;
        parsed = true;
      }
      return cachedRecord;
    };

    if (runDerived) {
      // Collect count targets (deduplicated across the whole batch)
      const existingRecordJson = existingMap.get(e.uri)?.record ?? null;
      collectCountTargets(
        e,
        config,
        existingRecordJson,
        countTargets,
        getRecord,
      );
      collectParentCountTargets(e, config, countTargets);
    }

    if (runFeed) {
      batch.push(
        ...buildFeedStatements(
          db,
          e,
          config,
          existingRecordStrings,
          getRecord,
        ),
      );
    }
    if (runDerived) {
      batch.push(...buildFtsStatements(db, e, config, getRecord));
    }
  }

  const projectionTokens = new Map(
    events.map((event) => [event.uri, crypto.randomUUID()] as const),
  );

  // Lock, verify the exact durable predecessors selected by the caller, then
  // write storage and version metadata. Any changed token violates the named
  // guard constraint and rolls the complete database batch back. Fresh
  // single-writer bulk loads (Alluvium bootstrap) skip the guard statements
  // and pack SQLite/D1 upserts via `json_each(?)` to keep batches to a few
  // prepared statements.
  const useJsonBulk = freshBulk && !isPostgresDialect(getDialect(db));
  batch.unshift(
    ...(freshBulk
      ? []
      : buildProjectionGuardStatements(db, events, predecessors)),
    ...buildRecordMutationStatements(db, storageMutations.values(), useJsonBulk),
    ...buildRecordVersionStatements(
      db,
      events,
      existingMap,
      projectionTokens,
      useJsonBulk,
    ),
  );

  // Build deduplicated count statements, then append the compact change batch.
  // Caller-provided source checkpoints deliberately remain last.
  // Counts (parent rows) precede moderation writes (moderation lock, then
  // recount queue rows). PostgreSQL writers then share one lock order: parent
  // rows -> moderation lock -> recount queue, matching moderation recounts and
  // trailing lifecycle statements. Visibility changed by this batch's actions
  // reaches parent counts through the recount queue.
  batch.push(...buildBatchCountStatements(db, config, countTargets));
  batch.push(...actionProjectionStatements(db, events, config));
  batch.push(
    ...labelBackfillEnqueueStatements(
      db,
      events.filter((e) => e.operation !== "delete").map((e) => e.did),
      config,
    ),
  );
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

export interface DerivedProjectionResumeCursor {
  stage: "fts" | "counts";
  /** Collection short name (parent short name for `counts`). */
  collection: string;
  /** Relation name when `stage === "counts"`. */
  relation?: string;
  /** Last completed key (`uri` for FTS and URI-matched counts, `did` for DID-matched counts). */
  after: string | null;
}

export interface DerivedProjectionProgress {
  stage: "fts" | "counts";
  collection: string;
  relation?: string;
  processed: number;
}

export interface RebuildDerivedProjectionsOptions {
  /** Rebuild FTS and relation counts in bounded keyset-paginated chunks rather
   * than single full-table statements (required on Cloudflare D1 to stay within
   * per-query CPU limits). Omit for single-statement bulk rebuilds (fastest on
   * local SQLite and PostgreSQL). */
  chunkSize?: number;
  /** Durable cursor to resume an interrupted chunked rebuild. */
  resume?: DerivedProjectionResumeCursor | null;
  /** Statement appended to each chunk's atomic `db.batch()` so the resume
   * cursor commits together with the chunk's writes. */
  checkpointStatement?: (cursor: DerivedProjectionResumeCursor) => Statement;
  /** Optional progress callback invoked after each chunk or stage. */
  onProgress?: (progress: DerivedProjectionProgress) => void;
}

async function hasVirtualFtsTable(
  db: Database,
  ftsTable: string,
  rowsTable: string,
): Promise<boolean> {
  const ftsRow = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(ftsTable)
    .first<{ name: string }>();
  if (ftsRow) return true;
  // initSchema creates fts_*_rows even when SQLite lacks the fts5 module and
  // skips only the virtual table. If fts_*_rows exists while fts_* does not,
  // treat FTS5 as unavailable on this runtime.
  const mappingRow = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(rowsTable)
    .first<{ name: string }>();
  if (mappingRow) return false;
  throw new Error(
    `FTS tables ${ftsTable} / ${rowsTable} are missing; run initSchema before rebuilding projections`,
  );
}

async function clearVirtualFtsInChunks(
  db: Database,
  ftsTable: string,
  rowsTable: string,
  chunkSize: number,
): Promise<void> {
  for (;;) {
    const rows =
      (
        await db
          .prepare(`SELECT id FROM ${rowsTable} ORDER BY id LIMIT ?`)
          .bind(chunkSize)
          .all<{ id: number }>()
      ).results ?? [];
    if (rows.length === 0) break;
    const minId = rows[0]!.id;
    const maxId = rows[rows.length - 1]!.id;
    await db.batch([
      db
        .prepare(`DELETE FROM ${ftsTable} WHERE rowid >= ? AND rowid <= ?`)
        .bind(minId, maxId),
      db
        .prepare(`DELETE FROM ${rowsTable} WHERE id >= ? AND id <= ?`)
        .bind(minId, maxId),
    ]);
    if (rows.length < chunkSize) break;
  }
  // Ensure no orphaned FTS rows remain when rowsTable is empty.
  const stray = await db
    .prepare(`SELECT rowid FROM ${ftsTable} LIMIT 1`)
    .first<{ rowid: number }>();
  if (stray) {
    await db.prepare(`DELETE FROM ${ftsTable}`).run();
  }
}

/** Rebuild projections that are intentionally skipped during canonical bulk
 * loading. Live ingestion and scheduled retries continue maintaining them
 * incrementally after this set-based catch-up. */
export async function rebuildDerivedProjections(
  db: Database,
  config: ContrailConfig,
  options: RebuildDerivedProjectionsOptions = {},
): Promise<void> {
  const dialect = getDialect(db);
  const chunkSize = options.chunkSize;
  if (
    chunkSize !== undefined &&
    (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)
  ) {
    throw new TypeError(
      "rebuildDerivedProjections chunkSize must be a positive integer",
    );
  }

  const ftsJobs: Array<{ short: string; fields: string[] }> = [];
  if (dialect.ftsStrategy === "virtual-table") {
    for (const [short, collection] of Object.entries(config.collections)) {
      const fields = getSearchableFields(short, collection);
      if (!fields || fields.length === 0) continue;
      ftsJobs.push({ short, fields });
    }
  }

  const countJobs: Array<{
    parentShort: string;
    parentTable: string;
    relationName: string;
    relation: RelationConfig;
  }> = [];
  for (const [parentShort, parentConfig] of Object.entries(
    config.collections,
  )) {
    const parentTable = recordsTableName(parentShort);
    for (const [relationName, relation] of Object.entries(
      parentConfig.relations ?? {},
    )) {
      if (relation.count === false) continue;
      countJobs.push({ parentShort, parentTable, relationName, relation });
    }
  }

  // Fast bulk path (local SQLite / PostgreSQL when chunkSize is omitted).
  if (chunkSize === undefined) {
    for (const { short, fields } of ftsJobs) {
      const ftsTable = ftsTableName(short);
      const rowsTable = ftsRowTableName(short);
      if (!(await hasVirtualFtsTable(db, ftsTable, rowsTable))) continue;
      await db.batch([
        db.prepare(`DELETE FROM ${ftsTable}`),
        db.prepare(`DELETE FROM ${rowsTable}`),
        ...populateVirtualFtsStatements(db, short, fields),
      ]);
    }

    const countStatements: Statement[] = [];
    for (const {
      parentShort,
      parentTable,
      relationName,
      relation,
    } of countJobs) {
      const {
        columns,
        projections,
        bindings,
        childTable,
        childTarget,
        parentTarget,
      } = buildRelationRebuildSpec(
        config,
        dialect,
        parentShort,
        relationName,
        relation,
      );
      // Reset parents with no matching children, then update only parents that
      // appear in one grouped child scan. This avoids N parents × M correlated
      // COUNT subqueries during a historical rebuild.
      countStatements.push(
        db.prepare(
          `UPDATE ${parentTable} SET ${columns
            .map((column) => `${column} = 0`)
            .join(", ")}`,
        ),
      );
      const aggregateUpdate = db.prepare(
        `WITH derived AS (
           SELECT ${childTarget} AS target, ${projections.join(", ")}
           FROM ${childTable} child
           WHERE ${visibleRecordSql("child")}
           GROUP BY ${childTarget}
         )
         UPDATE ${parentTable} AS parent
         SET ${columns
           .map((column) => `${column} = derived.${column}`)
           .join(", ")}
         FROM derived
         WHERE parent.${parentTarget} = derived.target`,
      );
      countStatements.push(
        bindings.length > 0
          ? aggregateUpdate.bind(...bindings)
          : aggregateUpdate,
      );
    }

    if (countStatements.length > 0) await db.batch(countStatements);
    return;
  }

  // Bounded chunked path (D1-safe & resumable).
  const resume = options.resume ?? null;
  let ftsStartIndex = 0;
  let countStartIndex = 0;
  let initialAfter: string | null = null;
  if (resume) {
    if (resume.stage === "fts") {
      ftsStartIndex = ftsJobs.findIndex(
        (job) => job.short === resume.collection,
      );
      if (ftsStartIndex < 0) {
        throw new Error(
          `Cannot resume FTS rebuild: collection "${resume.collection}" is not configured for FTS`,
        );
      }
      initialAfter = resume.after;
    } else {
      ftsStartIndex = ftsJobs.length;
      countStartIndex = countJobs.findIndex(
        (job) =>
          job.parentShort === resume.collection &&
          job.relationName === resume.relation,
      );
      if (countStartIndex < 0) {
        throw new Error(
          `Cannot resume relation-count rebuild: "${resume.collection}.${resume.relation ?? ""}" is not configured`,
        );
      }
      initialAfter = resume.after;
    }
  }

  for (let jobIndex = ftsStartIndex; jobIndex < ftsJobs.length; jobIndex++) {
    const { short, fields } = ftsJobs[jobIndex]!;
    const ftsTable = ftsTableName(short);
    const rowsTable = ftsRowTableName(short);
    const recordsTable = recordsTableName(short);
    if (!(await hasVirtualFtsTable(db, ftsTable, rowsTable))) continue;

    let after =
      resume?.stage === "fts" && jobIndex === ftsStartIndex
        ? initialAfter
        : null;
    if (after === null) {
      await clearVirtualFtsInChunks(db, ftsTable, rowsTable, chunkSize);
    }

    let processed = 0;
    for (;;) {
      const page =
        (after === null
          ? await db
              .prepare(`SELECT uri FROM ${recordsTable} ORDER BY uri LIMIT ?`)
              .bind(chunkSize)
              .all<{ uri: string }>()
          : await db
              .prepare(
                `SELECT uri FROM ${recordsTable} WHERE uri > ? ORDER BY uri LIMIT ?`,
              )
              .bind(after, chunkSize)
              .all<{ uri: string }>()
        ).results ?? [];
      if (page.length === 0) break;

      const firstUri = page[0]!.uri;
      const lastUri = page[page.length - 1]!.uri;
      const batch: Statement[] = [
        db
          .prepare(
            `DELETE FROM ${ftsTable}
             WHERE rowid IN (
               SELECT id FROM ${rowsTable} WHERE uri >= ? AND uri <= ?
             )`,
          )
          .bind(firstUri, lastUri),
        db
          .prepare(`DELETE FROM ${rowsTable} WHERE uri >= ? AND uri <= ?`)
          .bind(firstUri, lastUri),
        ...populateVirtualFtsStatements(db, short, fields, {
          firstUri,
          lastUri,
        }),
      ];
      if (options.checkpointStatement) {
        batch.push(
          options.checkpointStatement({
            stage: "fts",
            collection: short,
            after: lastUri,
          }),
        );
      }
      await db.batch(batch);
      processed += page.length;
      after = lastUri;
      options.onProgress?.({
        stage: "fts",
        collection: short,
        processed,
      });
      if (page.length < chunkSize) break;
    }
  }

  for (let jobIndex = countStartIndex; jobIndex < countJobs.length; jobIndex++) {
    const { parentShort, parentTable, relationName, relation } =
      countJobs[jobIndex]!;
    const {
      columns,
      projections,
      bindings,
      childTable,
      childTarget,
      parentTarget,
    } = buildRelationRebuildSpec(
      config,
      dialect,
      parentShort,
      relationName,
      relation,
    );
    // Keep total bindings per statement comfortably below D1's 100-parameter limit.
    const maxSubTargets = MAX_STATEMENT_BINDINGS - 10 - bindings.length;
    if (maxSubTargets < 1) {
      throw new Error(
        `Relation "${parentShort}.${relationName}" has too many grouped count bindings (${bindings.length}) for D1's ${MAX_STATEMENT_BINDINGS}-parameter statement limit`,
      );
    }
    const subChunkSize = Math.min(50, maxSubTargets);
    const nonZeroFilter = columns
      .map((column) => `${column} != 0`)
      .join(" OR ");
    const zeroAssignments = columns
      .map((column) => `${column} = 0`)
      .join(", ");
    const derivedAssignments = columns
      .map((column) => `${column} = derived.${column}`)
      .join(", ");

    let after =
      resume?.stage === "counts" && jobIndex === countStartIndex
        ? initialAfter
        : null;
    let processed = 0;

    for (;;) {
      const selectTargetsSql =
        parentTarget === "did"
          ? after === null
            ? `SELECT DISTINCT did AS target FROM ${parentTable} ORDER BY did LIMIT ?`
            : `SELECT DISTINCT did AS target FROM ${parentTable} WHERE did > ? ORDER BY did LIMIT ?`
          : after === null
            ? `SELECT uri AS target FROM ${parentTable} ORDER BY uri LIMIT ?`
            : `SELECT uri AS target FROM ${parentTable} WHERE uri > ? ORDER BY uri LIMIT ?`;
      const page =
        (after === null
          ? await db
              .prepare(selectTargetsSql)
              .bind(chunkSize)
              .all<{ target: string }>()
          : await db
              .prepare(selectTargetsSql)
              .bind(after, chunkSize)
              .all<{ target: string }>()
        ).results ?? [];
      if (page.length === 0) break;

      const targets = page.map((row) => row.target);
      const firstTarget = targets[0]!;
      const lastTarget = targets[targets.length - 1]!;
      const batch: Statement[] = [
        // Reset only parents in this key range that actually have non-zero counts,
        // avoiding redundant row writes on fresh Alluvium loads.
        db
          .prepare(
            `UPDATE ${parentTable}
             SET ${zeroAssignments}
             WHERE ${parentTarget} >= ? AND ${parentTarget} <= ?
               AND (${nonZeroFilter})`,
          )
          .bind(firstTarget, lastTarget),
      ];

      for (let offset = 0; offset < targets.length; offset += subChunkSize) {
        const subTargets = targets.slice(offset, offset + subChunkSize);
        const placeholders = subTargets.map(() => "?").join(", ");
        batch.push(
          db
            .prepare(
              `WITH derived AS (
                 SELECT ${childTarget} AS target, ${projections.join(", ")}
                 FROM ${childTable} child
                 WHERE ${childTarget} IN (${placeholders})
                   AND ${visibleRecordSql("child")}
                 GROUP BY ${childTarget}
               )
               UPDATE ${parentTable} AS parent
               SET ${derivedAssignments}
               FROM derived
               WHERE parent.${parentTarget} = derived.target`,
            )
            .bind(...bindings, ...subTargets),
        );
      }

      if (options.checkpointStatement) {
        batch.push(
          options.checkpointStatement({
            stage: "counts",
            collection: parentShort,
            relation: relationName,
            after: lastTarget,
          }),
        );
      }

      await db.batch(batch);
      processed += targets.length;
      after = lastTarget;
      options.onProgress?.({
        stage: "counts",
        collection: parentShort,
        relation: relationName,
        processed,
      });
      if (page.length < chunkSize) break;
    }
  }
}
