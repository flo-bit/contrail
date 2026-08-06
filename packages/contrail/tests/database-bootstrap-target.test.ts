import { describe, expect, it } from "vitest";
import {
  DatabaseBootstrapTarget,
  bootstrapFreshProjection,
  initSchema,
  queryRecords,
  resolveConfig,
  type ChangeSource,
  type PreparedSnapshot,
  type SnapshotSource,
  type SourcePosition,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

const COLLECTION = "com.example.event";
const DID = "did:plc:bootstrap";

function sourcePosition(cursor: number): SourcePosition {
  return { source: "jetstream-test", epoch: "epoch-one", cursor: String(cursor) };
}

function snapshot(): PreparedSnapshot {
  return {
    id: "pds-snapshot-one",
    provider: "pds",
    consistency: "sampled-current-state",
    collections: { [COLLECTION]: { state: "complete" } },
    semantics: {
      ordinaryRecords: true,
      ordinaryDeletes: true,
      accountLifecycle: false,
      repositoryReplacement: false,
      verifiedCommits: false,
      explicitHead: true,
    },
  };
}

function value(name: string) {
  return { $type: COLLECTION, name };
}

function record(rkey: string, name: string) {
  return {
    uri: `at://${DID}/${COLLECTION}/${rkey}`,
    did: DID,
    collection: COLLECTION,
    rkey,
    cid: `cid-${rkey}-${name}`,
    value: value(name),
  };
}

function config() {
  return resolveConfig({
    namespace: "com.example",
    profiles: [],
    constellation: false,
    collections: { event: { collection: COLLECTION } },
  });
}

describe("database bootstrap target", () => {
  it("projects a sampled snapshot and ordered tail with durable epochs", async () => {
    const resolved = config();
    const db = createSqliteDatabase(":memory:");
    await initSchema(db, resolved);
    const prepared = snapshot();
    const snapshotSource: SnapshotSource = {
      id: "pds",
      async prepare() {
        return prepared;
      },
      async *read() {
        yield {
          records: [record("a", "old"), record("b", "remove")],
          sourceTimeUs: 1,
          progress: { partition: "pds", cursor: null, complete: true },
          done: true,
        };
      },
    };
    let mark = 0;
    const changeSource: ChangeSource = {
      id: "jetstream",
      async mark() {
        mark++;
        return sourcePosition(mark === 1 ? 1 : 3);
      },
      async *read({ through }) {
        yield {
          mutations: [
            {
              operation: "put",
              ...record("a", "new"),
              sourceTimeUs: 2,
              position: sourcePosition(2),
            },
            {
              operation: "delete",
              uri: `at://${DID}/${COLLECTION}/b`,
              did: DID,
              collection: COLLECTION,
              rkey: "b",
              sourceTimeUs: 3,
              position: sourcePosition(3),
            },
          ],
          checkpoint: through,
          caughtUp: true,
        };
      },
    };
    const target = new DatabaseBootstrapTarget(db, resolved, {
      deferDerivedProjections: true,
    });

    await bootstrapFreshProjection({
      collections: [COLLECTION],
      snapshotSource,
      changeSource,
      target,
    });

    const records = await queryRecords(db, resolved, { collection: "event" });
    expect(records.records).toHaveLength(1);
    expect(JSON.parse(records.records[0].record).name).toBe("new");
    expect(await target.load()).toMatchObject({
      phase: "complete",
      snapshotProgress: [
        { partition: "pds", cursor: null, complete: true },
      ],
      snapshotComplete: true,
      captureFrom: sourcePosition(1),
      catchupThrough: sourcePosition(3),
      changeCheckpoint: sourcePosition(3),
    });
    expect(
      await db
        .prepare(
          "SELECT source_id, source_epoch, source_cursor FROM record_versions WHERE uri = ?",
        )
        .bind(`at://${DID}/${COLLECTION}/a`)
        .first(),
    ).toEqual({
      source_id: "jetstream-test",
      source_epoch: "epoch-one",
      source_cursor: "2",
    });
  });

  it("rolls projection back when snapshot progress cannot commit", async () => {
    const resolved = config();
    const db = createSqliteDatabase(":memory:");
    await initSchema(db, resolved);
    const target = new DatabaseBootstrapTarget(db, resolved);
    const prepared = snapshot();
    await target.begin(prepared, sourcePosition(1));
    await db
      .prepare(
        `CREATE TRIGGER fail_bootstrap_progress
         BEFORE INSERT ON bootstrap_snapshot_progress
         BEGIN SELECT RAISE(ABORT, 'injected bootstrap checkpoint failure'); END`,
      )
      .run();

    const batch = {
      records: [record("a", "atomic")],
      sourceTimeUs: 1,
      progress: { partition: "pds", cursor: null, complete: true },
      done: true,
    };
    await expect(target.applySnapshotBatch(prepared, batch)).rejects.toThrow(
      "injected bootstrap checkpoint failure",
    );

    expect(
      (await queryRecords(db, resolved, { collection: "event" })).records,
    ).toHaveLength(0);
    expect(await target.load()).toMatchObject({
      phase: "snapshot",
      snapshotProgress: [],
      snapshotComplete: false,
    });

    await db.prepare("DROP TRIGGER fail_bootstrap_progress").run();
    await target.applySnapshotBatch(prepared, batch);
    await target.beginCatchup(sourcePosition(1));
    await target.complete();

    expect(
      (await queryRecords(db, resolved, { collection: "event" })).records,
    ).toHaveLength(1);
    expect((await target.load())?.phase).toBe("complete");
  });

  it("rejects a mutation position from another epoch before advancing progress", async () => {
    const resolved = config();
    const db = createSqliteDatabase(":memory:");
    await initSchema(db, resolved);
    const target = new DatabaseBootstrapTarget(db, resolved);
    const prepared = snapshot();
    await target.begin(prepared, sourcePosition(1));
    await target.applySnapshotBatch(prepared, {
      records: [],
      sourceTimeUs: 1,
      progress: { partition: "pds", cursor: null, complete: true },
      done: true,
    });
    await target.beginCatchup(sourcePosition(3));

    await expect(
      target.applyMutationBatch({
        mutations: [
          {
            operation: "put",
            ...record("a", "wrong-epoch"),
            sourceTimeUs: 2,
            position: {
              source: "jetstream-test",
              epoch: "epoch-two",
              cursor: "2",
            },
          },
        ],
        checkpoint: sourcePosition(3),
        caughtUp: true,
      }),
    ).rejects.toThrow("belongs to jetstream-test/epoch-two");

    expect(await target.load()).toMatchObject({
      phase: "catchup",
      changeCheckpoint: sourcePosition(1),
    });
    expect(
      (await queryRecords(db, resolved, { collection: "event" })).records,
    ).toHaveLength(0);
  });
});
