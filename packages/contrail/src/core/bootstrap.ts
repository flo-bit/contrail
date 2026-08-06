import type { ContrailConfig, Database, IngestEvent, Statement } from "./types";
import { recordTimeUs, createIngestEvent, ingestRecords } from "./ingest";
import { getDependentNsids, recordsTableName } from "./types";
import { rebuildDerivedProjections } from "./db/records";
import type {
  BootstrapRunState,
  BootstrapTarget,
  MutationBatch,
  PreparedSnapshot,
  SnapshotBatch,
  SourceMutation,
  SourcePosition,
} from "./sources";

const BOOTSTRAP_STATE_ID = 1;

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
    const snapshot = parsePreparedSnapshot(row.snapshot_json);
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
      phase: row.phase,
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

  async begin(
    snapshot: PreparedSnapshot,
    captureFrom: SourcePosition,
  ): Promise<void> {
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
        JSON.stringify(snapshot),
        captureFrom.source,
        captureFrom.epoch,
        captureFrom.cursor,
        now,
        now,
      )
      .run();
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
    await this.apply(events, [checkpoint], false);
  }

  async complete(): Promise<void> {
    if (this.options.deferDerivedProjections) {
      await rebuildDerivedProjections(this.db, this.config);
    }
    await this.db
      .prepare(
        `UPDATE bootstrap_state
         SET phase = 'complete', finished_at = ?, updated_at = ?
         WHERE id = ? AND phase = 'catchup'
           AND change_source = catchup_source
           AND change_epoch = catchup_epoch
           AND change_cursor = catchup_cursor`,
      )
      .bind(Date.now(), Date.now(), BOOTSTRAP_STATE_ID)
      .run();
    const state = await this.load();
    if (state?.phase !== "complete") {
      throw new Error("Cannot complete bootstrap before catch-up reaches its target");
    }
  }

  private async apply(
    events: IngestEvent[],
    checkpoints: Statement[],
    authoritativeSourceObservation: boolean,
  ): Promise<void> {
    const knownDids = await this.getKnownDids();
    const result = await ingestRecords(this.db, events, this.config, {
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
    const identityRows = await this.db
      .prepare("SELECT did FROM identities")
      .all<{ did: string }>();
    for (const row of identityRows.results ?? []) known.add(row.did);
    for (const [shortName, collection] of Object.entries(
      this.config.collections,
    )) {
      if (collection.discover === false) continue;
      const rows = await this.db
        .prepare(`SELECT DISTINCT did FROM ${recordsTableName(shortName)}`)
        .all<{ did: string }>();
      for (const row of rows.results ?? []) known.add(row.did);
    }
    this.knownDids = known;
    this.knownDidsLoaded = true;
    return known;
  }
}
