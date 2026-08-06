/** Source-neutral contracts for building a fresh projection generation. */

export interface SourcePosition {
  /** Stable logical stream identifier. */
  source: string;
  /** Continuity epoch. Cursors from different epochs are never comparable. */
  epoch: string;
  /** Opaque cursor interpreted only by the source adapter. */
  cursor: string;
}

export interface SourceSemantics {
  ordinaryRecords: boolean;
  ordinaryDeletes: boolean;
  accountLifecycle: boolean;
  repositoryReplacement: boolean;
  verifiedCommits: boolean;
  explicitHead: boolean;
}

export type CollectionCoverage =
  | { state: "complete" }
  | { state: "partial"; reason: string; unresolved?: number }
  | { state: "gap"; reason: string };

export interface SnapshotRecord {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  cid: string;
  value: unknown;
}

export interface PreparedSnapshot {
  /** Provider-owned immutable snapshot identifier. */
  id: string;
  provider: string;
  consistency: "sampled-current-state" | "point-in-time";
  collections: Record<string, CollectionCoverage>;
  semantics: SourceSemantics;
  /** Upstream position represented by a point-in-time snapshot, when known. */
  through?: SourcePosition;
}

export interface SnapshotProgress {
  /** Stable provider-owned partition, such as one collection/repository pair. */
  partition: string;
  /** Opaque resume token within this partition, or null once complete. */
  cursor: string | null;
  complete: boolean;
}

export interface SnapshotBatch {
  records: SnapshotRecord[];
  /** Source observation time for ordering snapshot rows against later changes. */
  sourceTimeUs: number;
  /** Progress for the partition represented by this batch. */
  progress: SnapshotProgress;
  /** True only after every requested snapshot partition has completed. */
  done: boolean;
}

export interface SnapshotSource {
  readonly id: string;
  /** Prepare and pin a snapshot. Record acquisition must not begin before this
   * call; the bootstrap coordinator marks the change source first. */
  prepare(options: {
    collections: string[];
    signal?: AbortSignal;
  }): Promise<PreparedSnapshot>;
  read(options: {
    snapshot: PreparedSnapshot;
    progress?: SnapshotProgress[];
    signal?: AbortSignal;
  }): AsyncIterable<SnapshotBatch>;
}

interface MutationBase {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  revision?: string;
  sourceTimeUs: number;
  /** Per-event position when the source exposes one. */
  position?: SourcePosition;
}

export type SourceMutation =
  | (MutationBase & {
      operation: "put";
      cid: string;
      value: unknown;
    })
  | (MutationBase & {
      operation: "delete";
    });

export interface MutationBatch {
  mutations: SourceMutation[];
  /** Everything through this position has been accounted for, including
   * filtered events and an otherwise empty batch. */
  checkpoint: SourcePosition;
  /** True when the requested through-position has been reached exactly. */
  caughtUp: boolean;
}

export interface ChangeSource {
  readonly id: string;
  /** Return a durable replay coordinate near the current source head. */
  mark(options: {
    collections: string[];
    signal?: AbortSignal;
  }): Promise<SourcePosition>;
  read(options: {
    collections: string[];
    after: SourcePosition;
    through: SourcePosition;
    signal?: AbortSignal;
  }): AsyncIterable<MutationBatch>;
}

export type BootstrapPhase = "snapshot" | "catchup" | "complete";

/** Durable coordinator state. Snapshot progress and mutation checkpoints are
 * separate because they belong to different cursor namespaces. */
export interface BootstrapRunState {
  phase: BootstrapPhase;
  snapshot: PreparedSnapshot;
  captureFrom: SourcePosition;
  snapshotProgress: SnapshotProgress[];
  snapshotComplete: boolean;
  catchupThrough: SourcePosition | null;
  changeCheckpoint: SourcePosition | null;
}

/** Projection-owned persistence seam. Implementations commit records and the
 * accompanying progress/checkpoint atomically in the destination database. */
export interface BootstrapTarget {
  load(): Promise<BootstrapRunState | null>;
  begin(snapshot: PreparedSnapshot, captureFrom: SourcePosition): Promise<void>;
  applySnapshotBatch(
    snapshot: PreparedSnapshot,
    batch: SnapshotBatch,
  ): Promise<void>;
  beginCatchup(through: SourcePosition): Promise<void>;
  applyMutationBatch(batch: MutationBatch): Promise<void>;
  complete(): Promise<void>;
}

export interface BootstrapResult {
  snapshot: PreparedSnapshot;
  captureFrom: SourcePosition;
  through: SourcePosition;
}

function positionsEqual(left: SourcePosition, right: SourcePosition): boolean {
  return (
    left.source === right.source &&
    left.epoch === right.epoch &&
    left.cursor === right.cursor
  );
}

function assertCompatiblePosition(
  position: SourcePosition,
  expected: SourcePosition,
  label: string,
): void {
  if (
    position.source !== expected.source ||
    position.epoch !== expected.epoch
  ) {
    throw new Error(
      `${label} belongs to ${position.source}/${position.epoch}, expected ` +
        `${expected.source}/${expected.epoch}`,
    );
  }
}

function assertCoverage(
  snapshot: PreparedSnapshot,
  collections: string[],
  allowPartial: boolean,
): void {
  for (const collection of collections) {
    const coverage = snapshot.collections[collection];
    if (!coverage) {
      throw new Error(`Snapshot ${snapshot.id} omitted ${collection}`);
    }
    if (coverage.state === "gap") {
      throw new Error(
        `Snapshot ${snapshot.id} has a gap for ${collection}: ${coverage.reason}`,
      );
    }
    if (coverage.state === "partial" && !allowPartial) {
      throw new Error(
        `Snapshot ${snapshot.id} is partial for ${collection}: ${coverage.reason}`,
      );
    }
  }
}

/**
 * Build one fresh projection using capture-first snapshot/replay semantics.
 *
 * The target is responsible for applying every batch through Contrail's normal
 * admission/projector and persisting its progress in that same transaction.
 * A prepared point-in-time snapshot may supply its own upstream boundary;
 * sampled scans use the position marked before preparation begins.
 */
export async function bootstrapFreshProjection(options: {
  collections: string[];
  snapshotSource: SnapshotSource;
  changeSource: ChangeSource;
  target: BootstrapTarget;
  allowPartial?: boolean;
  signal?: AbortSignal;
}): Promise<BootstrapResult> {
  const {
    collections,
    snapshotSource,
    changeSource,
    target,
    signal,
  } = options;
  let state = await target.load();

  if (!state) {
    // Mark before snapshot preparation so even a provider that performs relay
    // discovery while preparing cannot open a capture gap.
    const marked = await changeSource.mark({ collections, signal });
    const snapshot = await snapshotSource.prepare({ collections, signal });
    assertCoverage(snapshot, collections, options.allowPartial === true);
    const captureFrom = snapshot.through ?? marked;
    assertCompatiblePosition(captureFrom, marked, "Snapshot boundary");
    await target.begin(snapshot, captureFrom);
    state = {
      phase: "snapshot",
      snapshot,
      captureFrom,
      snapshotProgress: [],
      snapshotComplete: false,
      catchupThrough: null,
      changeCheckpoint: null,
    };
  } else {
    assertCoverage(state.snapshot, collections, options.allowPartial === true);
  }

  if (!state.snapshotComplete) {
    let sawDone = false;
    for await (const batch of snapshotSource.read({
      snapshot: state.snapshot,
      ...(state.snapshotProgress.length === 0
        ? {}
        : { progress: state.snapshotProgress }),
      signal,
    })) {
      if (sawDone) {
        throw new Error(`Snapshot ${state.snapshot.id} emitted data after done`);
      }
      await target.applySnapshotBatch(state.snapshot, batch);
      const progressIndex = state.snapshotProgress.findIndex(
        (item) => item.partition === batch.progress.partition,
      );
      if (progressIndex < 0) state.snapshotProgress.push(batch.progress);
      else state.snapshotProgress[progressIndex] = batch.progress;
      state.snapshotComplete = batch.done;
      sawDone = batch.done;
    }
    if (!state.snapshotComplete) {
      throw new Error(`Snapshot ${state.snapshot.id} ended before done`);
    }
  }

  if (!state.catchupThrough) {
    const through = await changeSource.mark({ collections, signal });
    assertCompatiblePosition(through, state.captureFrom, "Catch-up target");
    await target.beginCatchup(through);
    state.catchupThrough = through;
    state.phase = "catchup";
  }

  if (state.phase !== "complete") {
    const after = state.changeCheckpoint ?? state.captureFrom;
    assertCompatiblePosition(after, state.catchupThrough, "Catch-up cursor");
    let caughtUp = positionsEqual(after, state.catchupThrough);

    if (!caughtUp) {
      for await (const batch of changeSource.read({
        collections,
        after,
        through: state.catchupThrough,
        signal,
      })) {
        assertCompatiblePosition(
          batch.checkpoint,
          state.catchupThrough,
          "Mutation checkpoint",
        );
        if (batch.caughtUp && !positionsEqual(batch.checkpoint, state.catchupThrough)) {
          throw new Error("Change source reported caught up at the wrong position");
        }
        await target.applyMutationBatch(batch);
        state.changeCheckpoint = batch.checkpoint;
        caughtUp = batch.caughtUp;
        if (caughtUp) break;
      }
    }

    if (!caughtUp) {
      throw new Error("Change source ended before the catch-up target");
    }
    await target.complete();
    state.phase = "complete";
  }

  return {
    snapshot: state.snapshot,
    captureFrom: state.captureFrom,
    through: state.catchupThrough,
  };
}
