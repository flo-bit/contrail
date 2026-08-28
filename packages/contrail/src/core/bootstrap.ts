import type { ContrailConfig, Database, IngestEvent, Statement } from "./types";
import { recordTimeUs, createIngestEvent, ingestRecords } from "./ingest";
import { getDependentNsids } from "./types";
import {
  loadKnownActorDids,
  rebuildDerivedProjections,
  saveCursorStatement,
  saveServingSourcePositionStatement,
} from "./db/records";
import {
  BOOTSTRAP_VERIFICATION_META_KEY,
  BootstrapVerificationError,
  verifyBootstrapCandidate,
} from "./verification";
import type {
  BootstrapFailureCategory,
  BootstrapRunState,
  BootstrapTarget,
  MutationBatch,
  PreparedSnapshot,
  SnapshotBatch,
  SourceMutation,
  SourcePosition,
} from "./sources";

const BOOTSTRAP_STATE_ID = 1;
/** Schema 9 predates the capture-before-prepare split. Keep its non-null
 * snapshot column and phase constraint compatible by using a private sentinel. */
const PREPARING_SNAPSHOT_JSON = "null";
const BOOTSTRAP_FAILURE_META_KEY = "bootstrap_last_failure";
const BOOTSTRAP_FAILURE_CATEGORIES = new Set<BootstrapFailureCategory>([
  "snapshot-incomplete",
  "catchup-incomplete",
  "source-history-expired",
  "verification-failed",
  "bootstrap-failed",
]);

export interface BootstrapFailureReport {
  category: BootstrapFailureCategory;
  failedAt: number;
  attempts: number;
}

interface BootstrapStateRow {
  phase: BootstrapRunState["phase"];
  snapshot_json: string;
  capture_source: string;
  capture_epoch: string;
  capture_cursor: string;
  snapshot_complete: number;
  catchup_source: string | null;
  catchup_epoch: string | null;
  catchup_cursor: string | null;
  change_source: string | null;
  change_epoch: string | null;
  change_cursor: string | null;
}

interface BootstrapProgressRow {
  partition: string;
  cursor: string | null;
  completed: number;
}

export interface DatabaseBootstrapTargetOptions {
  /** Skip FTS/count maintenance while loading and rebuild it before complete. */
  deferDerivedProjections?: boolean;
  /** Additional actors already known to be in acquisition scope. */
  knownDids?: ReadonlySet<string>;
  /** Map an opaque bootstrap checkpoint to the numeric cursor consumed by the
   * legacy cron Jetstream loop. The cursor commits atomically with each source
   * batch so ordinary scheduled ingestion can resume after bootstrap. */
  liveCursor?: (position: SourcePosition) => number;
}

function position(
  source: string | null,
  epoch: string | null,
  cursor: string | null,
  label: string,
): SourcePosition | null {
  if (source === null && epoch === null && cursor === null) return null;
  if (source === null || epoch === null || cursor === null) {
    throw new Error(`Incomplete durable ${label} position`);
  }
  return { source, epoch, cursor };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePreparedSnapshot(serialized: string): PreparedSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Durable bootstrap snapshot is not valid JSON");
  }
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.provider !== "string" ||
    (value.consistency !== "sampled-current-state" &&
      value.consistency !== "point-in-time") ||
    !isObject(value.collections) ||
    !isObject(value.semantics)
  ) {
    throw new Error("Durable bootstrap snapshot is malformed");
  }
  return value as unknown as PreparedSnapshot;
}

export async function getBootstrapFailure(
  db: Database,
): Promise<BootstrapFailureReport | null> {
  const row = await db
    .prepare("SELECT value FROM _contrail_meta WHERE key = ?")
    .bind(BOOTSTRAP_FAILURE_META_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    throw new Error("Durable bootstrap failure is not valid JSON");
  }
  if (
    !isObject(value) ||
    typeof value.category !== "string" ||
    !BOOTSTRAP_FAILURE_CATEGORIES.has(
      value.category as BootstrapFailureCategory,
    ) ||
    typeof value.failedAt !== "number" ||
    !Number.isSafeInteger(value.failedAt) ||
    value.failedAt < 0 ||
    typeof value.attempts !== "number" ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 1
  ) {
    throw new Error("Durable bootstrap failure is malformed");
  }
  return value as unknown as BootstrapFailureReport;
}

function sourceTimeUs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe microsecond value`);
  }
  return value;
}

function assertMutationPosition(
  mutation: SourceMutation,
  checkpoint: SourcePosition,
): SourcePosition {
  const eventPosition = mutation.position ?? checkpoint;
  if (
    eventPosition.source !== checkpoint.source ||
    eventPosition.epoch !== checkpoint.epoch
  ) {
    throw new Error(
      `Mutation ${mutation.uri} belongs to ${eventPosition.source}/${eventPosition.epoch}, ` +
        `but its batch belongs to ${checkpoint.source}/${checkpoint.epoch}`,
    );
  }
  return eventPosition;
}

/** Database-backed projection target for one unpublished fresh generation. */
export class DatabaseBootstrapTarget implements BootstrapTarget {
  private knownDids: Set<string> | undefined;
  private knownDidsLoaded = false;

  constructor(
    private readonly db: Database,
    private readonly config: ContrailConfig,
    private readonly options: DatabaseBootstrapTargetOptions = {},
  ) {
    if (options.knownDids) this.knownDids = new Set(options.knownDids);
  }

  async load(): Promise<BootstrapRunState | null> {
    const row = await this.db
      .prepare("SELECT * FROM bootstrap_state WHERE id = ?")
      .bind(BOOTSTRAP_STATE_ID)
      .first<BootstrapStateRow>();
    if (!row) return null;
    if (!(["snapshot", "catchup", "complete"] as string[]).includes(row.phase)) {
      throw new Error(`Invalid durable bootstrap phase: ${row.phase}`);
    }
    const preparing = row.snapshot_json === PREPARING_SNAPSHOT_JSON;
    const snapshot = preparing ? null : parsePreparedSnapshot(row.snapshot_json);
    const progressRows = await this.db
      .prepare(
        "SELECT partition, cursor, completed FROM bootstrap_snapshot_progress WHERE bootstrap_id = ? ORDER BY partition",
      )
      .bind(BOOTSTRAP_STATE_ID)
      .all<BootstrapProgressRow>();
    const captureFrom = position(
      row.capture_source,
      row.capture_epoch,
      row.capture_cursor,
      "capture",
    );
    if (!captureFrom) throw new Error("Durable bootstrap capture is missing");
    return {
      phase: preparing ? "preparing" : row.phase,
      snapshot,
      captureFrom,
      snapshotProgress: (progressRows.results ?? []).map((item) => ({
        partition: item.partition,
        cursor: item.cursor,
        complete: item.completed === 1,
      })),
      snapshotComplete: row.snapshot_complete === 1,
      catchupThrough: position(
        row.catchup_source,
        row.catchup_epoch,
        row.catchup_cursor,
        "catch-up target",
      ),
      changeCheckpoint: position(
        row.change_source,
        row.change_epoch,
        row.change_cursor,
        "change checkpoint",
      ),
    };
  }

  async beginCapture(captureFrom: SourcePosition): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO bootstrap_state
         (id, phase, snapshot_json, capture_source, capture_epoch,
          capture_cursor, snapshot_complete, started_at, updated_at)
         VALUES (?, 'snapshot', ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        BOOTSTRAP_STATE_ID,
        PREPARING_SNAPSHOT_JSON,
        captureFrom.source,
        captureFrom.epoch,
        captureFrom.cursor,
        now,
        now,
      )
      .run();
  }

  async setSnapshot(
    snapshot: PreparedSnapshot,
    captureFrom: SourcePosition,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE bootstrap_state
         SET phase = 'snapshot', snapshot_json = ?, capture_source = ?,
             capture_epoch = ?, capture_cursor = ?, updated_at = ?
         WHERE id = ? AND phase = 'snapshot' AND snapshot_json = ?`,
      )
      .bind(
        JSON.stringify(snapshot),
        captureFrom.source,
        captureFrom.epoch,
        captureFrom.cursor,
        Date.now(),
        BOOTSTRAP_STATE_ID,
        PREPARING_SNAPSHOT_JSON,
      )
      .run();
    const state = await this.load();
    if (state?.phase !== "snapshot" || !state.snapshot) {
      throw new Error("Could not pin the prepared bootstrap snapshot");
    }
  }

  async applySnapshotBatch(
    snapshot: PreparedSnapshot,
    batch: SnapshotBatch,
  ): Promise<void> {
    const observedAtUs = sourceTimeUs(
      batch.sourceTimeUs,
      "Snapshot sourceTimeUs",
    );
    const indexedAt = Date.now() * 1000;
    const events = batch.records.map((item) =>
      createIngestEvent({
        uri: item.uri,
        did: item.did,
        collection: item.collection,
        rkey: item.rkey,
        operation: "update",
        cid: item.cid,
        value: item.value,
        timeUs: recordTimeUs(
          item.value,
          item.collection,
          this.config,
          observedAtUs,
        ),
        indexedAt,
        source: {
          id: `snapshot:${snapshot.provider}`,
          epoch: snapshot.through?.epoch ?? snapshot.id,
          time_us: observedAtUs,
          revision: null,
          cursor: batch.progress.cursor ?? batch.progress.partition,
        },
      }),
    );
    const now = Date.now();
    const progress = this.db
      .prepare(
        `INSERT INTO bootstrap_snapshot_progress
         (bootstrap_id, partition, cursor, completed, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bootstrap_id, partition) DO UPDATE SET
           cursor = excluded.cursor,
           completed = excluded.completed,
           updated_at = excluded.updated_at`,
      )
      .bind(
        BOOTSTRAP_STATE_ID,
        batch.progress.partition,
        batch.progress.cursor,
        batch.progress.complete ? 1 : 0,
        now,
      );
    const checkpoint = this.db
      .prepare(
        `UPDATE bootstrap_state
         SET snapshot_complete = ?, updated_at = ?
         WHERE id = ? AND phase = 'snapshot'`,
      )
      .bind(batch.done ? 1 : 0, now, BOOTSTRAP_STATE_ID);
    await this.apply(events, [progress, checkpoint], true);
  }

  async beginCatchup(through: SourcePosition): Promise<void> {
    await this.db
      .prepare(
        `UPDATE bootstrap_state
         SET phase = 'catchup', catchup_source = ?, catchup_epoch = ?,
             catchup_cursor = ?, change_source = capture_source,
             change_epoch = capture_epoch, change_cursor = capture_cursor,
             updated_at = ?
         WHERE id = ? AND phase = 'snapshot' AND snapshot_complete = 1`,
      )
      .bind(
        through.source,
        through.epoch,
        through.cursor,
        Date.now(),
        BOOTSTRAP_STATE_ID,
      )
      .run();
    const state = await this.load();
    if (state?.phase !== "catchup") {
      throw new Error("Cannot begin catch-up before the snapshot is complete");
    }
  }

  async applyMutationBatch(batch: MutationBatch): Promise<void> {
    const indexedAt = Date.now() * 1000;
    const events = batch.mutations.map((mutation) => {
      const eventPosition = assertMutationPosition(mutation, batch.checkpoint);
      const observedAtUs = sourceTimeUs(
        mutation.sourceTimeUs,
        `Mutation ${mutation.uri} sourceTimeUs`,
      );
      return createIngestEvent({
        uri: mutation.uri,
        did: mutation.did,
        collection: mutation.collection,
        rkey: mutation.rkey,
        operation: mutation.operation === "delete" ? "delete" : "update",
        cid: mutation.operation === "delete" ? null : mutation.cid,
        value: mutation.operation === "delete" ? undefined : mutation.value,
        timeUs:
          mutation.operation === "delete"
            ? observedAtUs
            : recordTimeUs(
                mutation.value,
                mutation.collection,
                this.config,
                observedAtUs,
              ),
        indexedAt,
        source: {
          id: eventPosition.source,
          epoch: eventPosition.epoch,
          time_us: observedAtUs,
          revision: mutation.revision ?? null,
          cursor: eventPosition.cursor,
        },
      });
    });
    const checkpoint = this.db
      .prepare(
        `UPDATE bootstrap_state
         SET change_source = ?, change_epoch = ?, change_cursor = ?, updated_at = ?
         WHERE id = ? AND phase = 'catchup'`,
      )
      .bind(
        batch.checkpoint.source,
        batch.checkpoint.epoch,
        batch.checkpoint.cursor,
        Date.now(),
        BOOTSTRAP_STATE_ID,
      );
    const liveCursor = this.options.liveCursor?.(batch.checkpoint);
    await this.apply(
      events,
      [
        checkpoint,
        saveServingSourcePositionStatement(this.db, batch.checkpoint),
        ...(liveCursor === undefined
          ? []
          : [saveCursorStatement(this.db, sourceTimeUs(liveCursor, "Live cursor"))]),
      ],
      false,
    );
  }

  async complete(): Promise<void> {
    const before = await this.load();
    if (
      before?.phase !== "catchup" ||
      !before.catchupThrough ||
      !before.changeCheckpoint ||
      before.catchupThrough.source !== before.changeCheckpoint.source ||
      before.catchupThrough.epoch !== before.changeCheckpoint.epoch ||
      before.catchupThrough.cursor !== before.changeCheckpoint.cursor
    ) {
      throw new Error("Cannot complete bootstrap before catch-up reaches its target");
    }
    if (this.options.deferDerivedProjections) {
      await rebuildDerivedProjections(this.db, this.config);
    }
    const report = await verifyBootstrapCandidate(this.db, this.config);
    const verification = this.db
      .prepare(
        `INSERT INTO _contrail_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(BOOTSTRAP_VERIFICATION_META_KEY, JSON.stringify(report));
    if (!report.ok) {
      await verification.run();
      throw new BootstrapVerificationError(report);
    }

    const now = Date.now();
    const clearFailure = this.db
      .prepare("DELETE FROM _contrail_meta WHERE key = ?")
      .bind(BOOTSTRAP_FAILURE_META_KEY);
    const completion = this.db
      .prepare(
        `UPDATE bootstrap_state
         SET phase = 'complete', finished_at = ?, updated_at = ?
         WHERE id = ? AND phase = 'catchup'
           AND change_source = catchup_source
           AND change_epoch = catchup_epoch
           AND change_cursor = catchup_cursor`,
      )
      .bind(now, now, BOOTSTRAP_STATE_ID);
    await this.db.batch([verification, clearFailure, completion]);
    const state = await this.load();
    if (state?.phase !== "complete") {
      throw new Error("Cannot complete bootstrap before catch-up reaches its target");
    }
  }

  async recordFailure(category: BootstrapFailureCategory): Promise<void> {
    const prior = await getBootstrapFailure(this.db);
    const report: BootstrapFailureReport = {
      category,
      failedAt: Date.now(),
      attempts: (prior?.attempts ?? 0) + 1,
    };
    await this.db
      .prepare(
        `INSERT INTO _contrail_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(BOOTSTRAP_FAILURE_META_KEY, JSON.stringify(report))
      .run();
  }

  private async apply(
    events: IngestEvent[],
    checkpoints: Statement[],
    authoritativeSourceObservation: boolean,
  ): Promise<void> {
    const knownDids = await this.getKnownDids();
    const result = await ingestRecords(this.db, events, this.config, {
      phase: "historical",
      knownDids,
      skipDerivedProjections: this.options.deferDerivedProjections === true,
      authoritativeSourceObservation,
      trailingStatements: checkpoints,
    });
    if (knownDids) {
      for (const did of result.discoveredDids) knownDids.add(did);
    }
  }

  private async getKnownDids(): Promise<Set<string> | undefined> {
    if (getDependentNsids(this.config).length === 0) return undefined;
    if (this.knownDidsLoaded) return this.knownDids ?? new Set();
    const known = this.knownDids ?? new Set<string>();
    for (const did of await loadKnownActorDids(this.db, this.config)) {
      known.add(did);
    }
    this.knownDids = known;
    this.knownDidsLoaded = true;
    return known;
  }
}
