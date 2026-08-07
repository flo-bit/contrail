import { describe, expect, it } from "vitest";
import {
  bootstrapFreshProjection,
  type BootstrapRunState,
  type BootstrapTarget,
  type ChangeSource,
  type MutationBatch,
  type PreparedSnapshot,
  type SnapshotBatch,
  type SnapshotProgress,
  type SnapshotRecord,
  type SnapshotSource,
  type SourceMutation,
  type SourcePosition,
} from "../src/index";

const COLLECTION = "com.example.event";
const ALICE = "did:plc:alice";

function position(cursor: number): SourcePosition {
  return { source: "test-stream", epoch: "one", cursor: String(cursor) };
}

function record(rkey: string, value: number): SnapshotRecord {
  return {
    uri: `at://${ALICE}/${COLLECTION}/${rkey}`,
    did: ALICE,
    collection: COLLECTION,
    rkey,
    cid: `cid-${rkey}-${value}`,
    value: { value },
  };
}

function put(rkey: string, value: number, cursor: number): SourceMutation {
  return {
    operation: "put",
    ...record(rkey, value),
    sourceTimeUs: cursor,
    position: position(cursor),
  };
}

function deletion(rkey: string, cursor: number): SourceMutation {
  return {
    operation: "delete",
    uri: `at://${ALICE}/${COLLECTION}/${rkey}`,
    did: ALICE,
    collection: COLLECTION,
    rkey,
    sourceTimeUs: cursor,
    position: position(cursor),
  };
}

const semantics = {
  ordinaryRecords: true,
  ordinaryDeletes: true,
  accountLifecycle: false,
  repositoryReplacement: false,
  verifiedCommits: false,
  explicitHead: true,
};

class MemoryTarget implements BootstrapTarget {
  state: BootstrapRunState | null = null;
  records = new Map<string, SnapshotRecord>();
  snapshotBatches = 0;
  mutationBatches = 0;

  async load() {
    return this.state ? structuredClone(this.state) : null;
  }

  async beginCapture(captureFrom: SourcePosition) {
    this.state = {
      phase: "preparing",
      snapshot: null,
      captureFrom: structuredClone(captureFrom),
      snapshotProgress: [],
      snapshotComplete: false,
      catchupThrough: null,
      changeCheckpoint: null,
    };
  }

  async setSnapshot(snapshot: PreparedSnapshot, captureFrom: SourcePosition) {
    this.state!.phase = "snapshot";
    this.state!.snapshot = structuredClone(snapshot);
    this.state!.captureFrom = structuredClone(captureFrom);
  }

  async applySnapshotBatch(_snapshot: PreparedSnapshot, batch: SnapshotBatch) {
    for (const item of batch.records) this.records.set(item.uri, item);
    this.snapshotBatches++;
    const index = this.state!.snapshotProgress.findIndex(
      (item) => item.partition === batch.progress.partition,
    );
    if (index < 0) this.state!.snapshotProgress.push(batch.progress);
    else this.state!.snapshotProgress[index] = batch.progress;
    this.state!.snapshotComplete = batch.done;
  }

  async beginCatchup(through: SourcePosition) {
    this.state!.phase = "catchup";
    this.state!.catchupThrough = structuredClone(through);
  }

  async applyMutationBatch(batch: MutationBatch) {
    for (const mutation of batch.mutations) {
      if (mutation.operation === "delete") {
        this.records.delete(mutation.uri);
      } else {
        this.records.set(mutation.uri, {
          uri: mutation.uri,
          did: mutation.did,
          collection: mutation.collection,
          rkey: mutation.rkey,
          cid: mutation.cid,
          value: mutation.value,
        });
      }
    }
    this.mutationBatches++;
    this.state!.changeCheckpoint = structuredClone(batch.checkpoint);
  }

  async complete() {
    this.state!.phase = "complete";
  }
}

function snapshotSource(options: {
  snapshot: PreparedSnapshot;
  batches(progress?: SnapshotProgress[]): SnapshotBatch[];
  calls?: string[];
}): SnapshotSource {
  return {
    id: options.snapshot.provider,
    async prepare() {
      options.calls?.push("prepare");
      return structuredClone(options.snapshot);
    },
    async *read({ progress }) {
      const cursor = progress?.find((item) => item.partition === "main")?.cursor;
      options.calls?.push(`snapshot:${cursor ?? "start"}`);
      for (const batch of options.batches(progress)) yield structuredClone(batch);
    },
  };
}

function changeSource(options: {
  marks: number[];
  mutations: SourceMutation[];
  calls?: string[];
}): ChangeSource {
  let markIndex = 0;
  return {
    id: "changes",
    semantics,
    async mark() {
      const cursor = options.marks[markIndex++];
      if (cursor === undefined) throw new Error("Unexpected mark");
      options.calls?.push(`mark:${cursor}`);
      return position(cursor);
    },
    async *read({ after, through }) {
      options.calls?.push(`changes:${after.cursor}-${through.cursor}`);
      const lower = Number(after.cursor);
      const upper = Number(through.cursor);
      const mutations = options.mutations.filter((mutation) => {
        const cursor = Number(mutation.position?.cursor);
        return cursor > lower && cursor <= upper;
      });
      yield {
        mutations,
        checkpoint: structuredClone(through),
        caughtUp: true,
      };
    },
  };
}

function prepared(overrides: Partial<PreparedSnapshot> = {}): PreparedSnapshot {
  return {
    id: "snapshot-one",
    provider: "test-snapshot",
    consistency: "sampled-current-state",
    collections: { [COLLECTION]: { state: "complete" } },
    semantics,
    ...overrides,
  };
}

describe("bootstrap source orchestration", () => {
  it("marks before a sampled scan and replays mutations that raced it", async () => {
    const calls: string[] = [];
    const snapshot = snapshotSource({
      snapshot: prepared(),
      calls,
      batches: () => [
        {
          // Alice was sampled at different moments: A already reflects cursor
          // 3, B is stale at cursor 2, and C did not exist when sampled.
          records: [record("a", 3), record("b", 2)],
          sourceTimeUs: 3,
          progress: { partition: "main", cursor: null, complete: true },
          done: true,
        },
      ],
    });
    const changes = changeSource({
      marks: [2, 5],
      calls,
      mutations: [put("a", 3, 3), deletion("b", 4), put("c", 5, 5)],
    });
    const target = new MemoryTarget();

    const result = await bootstrapFreshProjection({
      collections: [COLLECTION],
      snapshotSource: snapshot,
      changeSource: changes,
      target,
    });

    expect(calls).toEqual([
      "mark:2",
      "prepare",
      "snapshot:start",
      "mark:5",
      "changes:2-5",
    ]);
    expect(result.captureFrom).toEqual(position(2));
    expect(result.through).toEqual(position(5));
    expect(
      [...target.records.values()]
        .map((item) => [item.rkey, (item.value as { value: number }).value])
        .sort(),
    ).toEqual([
      ["a", 3],
      ["c", 5],
    ]);
    expect(target.state?.phase).toBe("complete");
  });

  it("uses a point-in-time snapshot boundary instead of the preliminary mark", async () => {
    const calls: string[] = [];
    const snapshot = snapshotSource({
      snapshot: prepared({
        consistency: "point-in-time",
        through: position(5),
      }),
      calls,
      batches: () => [
        {
          records: [record("a", 5)],
          sourceTimeUs: 5,
          progress: { partition: "main", cursor: null, complete: true },
          done: true,
        },
      ],
    });
    const changes = changeSource({
      // The preliminary mark happens before the manifest is pinned. The
      // snapshot's own boundary is the correct tail starting point.
      marks: [10, 12],
      calls,
      mutations: [put("a", 6, 6), put("b", 11, 11)],
    });
    const target = new MemoryTarget();

    const result = await bootstrapFreshProjection({
      collections: [COLLECTION],
      snapshotSource: snapshot,
      changeSource: changes,
      target,
    });

    expect(result.captureFrom).toEqual(position(5));
    expect(calls.at(-1)).toBe("changes:5-12");
    expect(
      [...target.records.values()]
        .map((item) => [item.rkey, (item.value as { value: number }).value])
        .sort(),
    ).toEqual([
      ["a", 6],
      ["b", 11],
    ]);
  });

  it("retains the original capture mark when snapshot preparation is retried", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const source: SnapshotSource = {
      id: "retrying-snapshot",
      async prepare() {
        calls.push(`prepare:${++attempts}`);
        if (attempts === 1) throw new Error("discovery unavailable");
        return prepared();
      },
      async *read() {
        yield {
          records: [],
          sourceTimeUs: 1,
          progress: { partition: "main", cursor: null, complete: true },
          done: true,
        };
      },
    };
    const changes = changeSource({ marks: [1, 3], mutations: [], calls });
    const target = new MemoryTarget();

    await expect(
      bootstrapFreshProjection({
        collections: [COLLECTION],
        snapshotSource: source,
        changeSource: changes,
        target,
      }),
    ).rejects.toThrow("discovery unavailable");
    expect(target.state).toMatchObject({
      phase: "preparing",
      captureFrom: position(1),
    });

    await bootstrapFreshProjection({
      collections: [COLLECTION],
      snapshotSource: source,
      changeSource: changes,
      target,
    });

    expect(calls).toEqual([
      "mark:1",
      "prepare:1",
      "prepare:2",
      "mark:3",
      "changes:1-3",
    ]);
    expect(target.state?.phase).toBe("complete");
  });

  it("resumes a pinned snapshot from its last committed progress", async () => {
    const reads: Array<string | undefined> = [];
    let failSecondBatch = true;
    const snapshot = snapshotSource({
      snapshot: prepared(),
      batches(progress) {
        const cursor = progress?.find((item) => item.partition === "main")?.cursor;
        reads.push(cursor);
        if (cursor === "part-1") {
          return [
            {
              records: [record("b", 2)],
              sourceTimeUs: 2,
              progress: { partition: "main", cursor: null, complete: true },
              done: true,
            },
          ];
        }
        return [
          {
            records: [record("a", 1)],
            sourceTimeUs: 1,
            progress: {
              partition: "main",
              cursor: "part-1",
              complete: false,
            },
            done: false,
          },
          {
            records: [record("b", 2)],
            sourceTimeUs: 2,
            progress: { partition: "main", cursor: null, complete: true },
            done: true,
          },
        ];
      },
    });
    const changes = changeSource({ marks: [1, 3], mutations: [] });
    const target = new MemoryTarget();
    const apply = target.applySnapshotBatch.bind(target);
    target.applySnapshotBatch = async (preparedSnapshot, batch) => {
      if (batch.progress.complete && failSecondBatch) {
        failSecondBatch = false;
        throw new Error("injected snapshot failure");
      }
      await apply(preparedSnapshot, batch);
    };

    await expect(
      bootstrapFreshProjection({
        collections: [COLLECTION],
        snapshotSource: snapshot,
        changeSource: changes,
        target,
      }),
    ).rejects.toThrow("injected snapshot failure");

    await bootstrapFreshProjection({
      collections: [COLLECTION],
      snapshotSource: snapshot,
      changeSource: changes,
      target,
    });

    expect(reads).toEqual([undefined, "part-1"]);
    expect(target.snapshotBatches).toBe(2);
    expect([...target.records.values()].map((item) => item.rkey).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("commits an empty change batch to prove progress through the target", async () => {
    const snapshot = snapshotSource({
      snapshot: prepared(),
      batches: () => [
        {
          records: [],
          sourceTimeUs: 1,
          progress: { partition: "main", cursor: null, complete: true },
          done: true,
        },
      ],
    });
    const target = new MemoryTarget();

    await bootstrapFreshProjection({
      collections: [COLLECTION],
      snapshotSource: snapshot,
      changeSource: changeSource({ marks: [1, 2], mutations: [] }),
      target,
    });

    expect(target.mutationBatches).toBe(1);
    expect(target.state?.changeCheckpoint).toEqual(position(2));
    expect(target.state?.phase).toBe("complete");
  });

  it("refuses a point-in-time boundary from another source epoch", async () => {
    const snapshot = snapshotSource({
      snapshot: prepared({
        consistency: "point-in-time",
        through: { source: "test-stream", epoch: "old", cursor: "5" },
      }),
      batches: () => [],
    });
    const target = new MemoryTarget();

    await expect(
      bootstrapFreshProjection({
        collections: [COLLECTION],
        snapshotSource: snapshot,
        changeSource: changeSource({ marks: [10], mutations: [] }),
        target,
      }),
    ).rejects.toThrow("Snapshot boundary belongs to test-stream/old");
    expect(target.state).toMatchObject({
      phase: "preparing",
      captureFrom: position(10),
    });
  });

  it("blocks readiness when required source semantics are not guaranteed", async () => {
    const target = new MemoryTarget();
    const changes = changeSource({ marks: [1], mutations: [] });

    await expect(
      bootstrapFreshProjection({
        collections: [COLLECTION],
        snapshotSource: snapshotSource({
          snapshot: prepared(),
          batches: () => [],
        }),
        changeSource: changes,
        target,
        requiredSemantics: { accountLifecycle: true },
      }),
    ).rejects.toThrow("required accountLifecycle");

    expect(target.state).toMatchObject({
      phase: "snapshot",
      snapshotComplete: false,
    });
  });

  it("refuses partial and gapped coverage by default", async () => {
    for (const coverage of [
      { state: "partial" as const, reason: "one PDS unavailable" },
      { state: "gap" as const, reason: "source retention expired" },
    ]) {
      const snapshot = snapshotSource({
        snapshot: prepared({ collections: { [COLLECTION]: coverage } }),
        batches: () => [],
      });
      const target = new MemoryTarget();

      await expect(
        bootstrapFreshProjection({
          collections: [COLLECTION],
          snapshotSource: snapshot,
          changeSource: changeSource({ marks: [1], mutations: [] }),
          target,
        }),
      ).rejects.toThrow(coverage.reason);
      expect(target.state).toMatchObject({
        phase: "preparing",
        captureFrom: position(1),
      });
    }
  });
});
