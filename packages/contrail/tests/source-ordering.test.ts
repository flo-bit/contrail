import { describe, expect, it } from "vitest";
import {
  createIngestEvent,
  ingestRecords,
  initSchema,
  getServingSourcePosition,
  queryRecords,
  resolveConfig,
  saveCursorStatement,
  saveOrderedSourcePositionStatement,
  type ContrailConfig,
  type Database,
  type IngestEvent,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

const COLLECTION = "com.example.event";
const URI = `at://did:plc:alice/${COLLECTION}/one`;
const logger = { log() {}, warn() {}, error() {} };

function config(overrides: Partial<ContrailConfig> = {}) {
  return resolveConfig({
    namespace: "com.example",
    logger,
    collections: {
      event: {
        collection: COLLECTION,
        ...(overrides.collections?.event ?? {}),
      },
    },
    ...overrides,
  });
}

async function setup(resolved = config()): Promise<Database> {
  const db = createSqliteDatabase(":memory:");
  await initSchema(db, resolved);
  return db;
}

function mutation(options: {
  operation: "create" | "update" | "delete";
  sourceTime: number;
  revision?: string | null;
  cid?: string;
  name?: string;
  recordTime?: number;
  sourceId?: string;
  epoch?: string;
}): IngestEvent {
  return createIngestEvent({
    uri: URI,
    did: "did:plc:alice",
    collection: COLLECTION,
    rkey: "one",
    operation: options.operation,
    cid: options.cid,
    value:
      options.operation === "delete"
        ? undefined
        : { name: options.name ?? options.cid ?? "event" },
    timeUs: options.recordTime ?? 10,
    indexedAt: options.sourceTime + 10_000,
    source: {
      id: options.sourceId ?? "fake-source",
      ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
      time_us: options.sourceTime,
      revision: options.revision ?? null,
      cursor: String(options.sourceTime),
    },
  });
}

async function visibleName(db: Database, resolved = config()) {
  const result = await queryRecords(db, resolved, { collection: "event" });
  const record = result.records[0]?.record;
  return record ? (JSON.parse(record).name as string | undefined) : undefined;
}

describe("durable source ordering", () => {
  it("rejects stale and duplicate updates before projection", async () => {
    const resolved = config();
    const db = await setup(resolved);
    const newest = mutation({
      operation: "update",
      sourceTime: 200,
      revision: "2",
      cid: "cid-new",
      name: "new",
    });

    await ingestRecords(
      db,
      [
        mutation({
          operation: "create",
          sourceTime: 100,
          revision: "1",
          cid: "cid-old",
          name: "old",
        }),
        newest,
      ],
      resolved,
    );
    const stale = await ingestRecords(
      db,
      [
        mutation({
          operation: "update",
          sourceTime: 300,
          revision: "1",
          cid: "cid-stale",
          name: "stale",
        }),
        newest,
      ],
      resolved,
    );

    expect(await visibleName(db, resolved)).toBe("new");
    expect(stale.accepted).toHaveLength(0);
    expect(stale.dropped.superseded).toBe(2);
  });

  it("does not compare opaque cursors across source epochs", async () => {
    const resolved = config();
    const db = await setup(resolved);
    await ingestRecords(
      db,
      [
        mutation({
          operation: "delete",
          sourceTime: 100,
          sourceId: "same-source",
          epoch: "epoch-a",
          revision: null,
        }),
      ],
      resolved,
    );

    const nextEpoch = await ingestRecords(
      db,
      [
        {
          ...mutation({
            operation: "delete",
            sourceTime: 100,
            sourceId: "same-source",
            epoch: "epoch-b",
            revision: null,
          }),
          source: {
            id: "same-source",
            epoch: "epoch-b",
            time_us: 100,
            revision: null,
            cursor: "1",
          },
        },
      ],
      resolved,
    );

    expect(nextEpoch.accepted).toHaveLength(1);
    expect(
      await db
        .prepare(
          "SELECT source_epoch, source_cursor FROM record_versions WHERE uri = ?",
        )
        .bind(URI)
        .first(),
    ).toEqual({ source_epoch: "epoch-b", source_cursor: "1" });
  });

  it("does not let a stale delete remove a newer record", async () => {
    const resolved = config();
    const db = await setup(resolved);
    await ingestRecords(
      db,
      [
        mutation({
          operation: "create",
          sourceTime: 200,
          revision: "2",
          cid: "cid-new",
          name: "new",
        }),
      ],
      resolved,
    );

    const result = await ingestRecords(
      db,
      [mutation({ operation: "delete", sourceTime: 300, revision: "1" })],
      resolved,
    );

    expect(result.dropped.superseded).toBe(1);
    expect(await visibleName(db, resolved)).toBe("new");
  });

  it("keeps a tombstone that blocks stale resurrection but permits a newer create", async () => {
    const resolved = config();
    const db = await setup(resolved);
    await ingestRecords(
      db,
      [
        mutation({
          operation: "create",
          sourceTime: 200,
          revision: "2",
          cid: "cid-before-delete",
        }),
      ],
      resolved,
    );
    await ingestRecords(
      db,
      [mutation({ operation: "delete", sourceTime: 300, revision: "3" })],
      resolved,
    );

    const tombstone = await db
      .prepare(
        "SELECT operation, cid, source_revision, source_time_us FROM record_versions WHERE uri = ?",
      )
      .bind(URI)
      .first<{
        operation: string;
        cid: string | null;
        source_revision: string | null;
        source_time_us: number;
      }>();
    expect(tombstone).toEqual({
      operation: "delete",
      cid: "cid-before-delete",
      source_revision: "3",
      source_time_us: 300,
    });

    const stale = await ingestRecords(
      db,
      [
        mutation({
          operation: "create",
          sourceTime: 200,
          revision: "2",
          cid: "cid-stale",
          name: "stale",
        }),
      ],
      resolved,
    );
    expect(stale.dropped.superseded).toBe(1);
    expect(await visibleName(db, resolved)).toBeUndefined();

    await ingestRecords(
      db,
      [
        mutation({
          operation: "create",
          sourceTime: 400,
          revision: "4",
          cid: "cid-current",
          name: "current",
        }),
      ],
      resolved,
    );
    expect(await visibleName(db, resolved)).toBe("current");
  });

  it("uses source observation time consistently when only one adapter has a revision", async () => {
    const resolved = config();
    const db = await setup(resolved);
    await ingestRecords(
      db,
      [
        mutation({
          operation: "create",
          sourceTime: 200,
          sourceId: "pds-notify",
          cid: "cid-notify",
          name: "notify",
        }),
      ],
      resolved,
    );

    await ingestRecords(
      db,
      [
        mutation({
          operation: "update",
          sourceTime: 100,
          sourceId: "jetstream",
          revision: "1",
          cid: "cid-old-stream",
          name: "old stream",
        }),
      ],
      resolved,
    );
    expect(await visibleName(db, resolved)).toBe("notify");

    await ingestRecords(
      db,
      [
        mutation({
          operation: "update",
          sourceTime: 300,
          sourceId: "jetstream",
          revision: "2",
          cid: "cid-new-stream",
          name: "new stream",
        }),
      ],
      resolved,
    );
    expect(await visibleName(db, resolved)).toBe("new stream");
  });

  it("converges for every ordering of one create/update/delete history", async () => {
    const resolved = config();
    const history = [
      mutation({
        operation: "create",
        sourceTime: 100,
        revision: "1",
        cid: "cid-create",
      }),
      mutation({
        operation: "update",
        sourceTime: 200,
        revision: "2",
        cid: "cid-update",
      }),
      mutation({ operation: "delete", sourceTime: 300, revision: "3" }),
    ];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];

    for (const order of permutations) {
      const db = await setup(resolved);
      for (const index of order) {
        await ingestRecords(db, [history[index]], resolved);
      }
      expect(await visibleName(db, resolved)).toBeUndefined();
      const version = await db
        .prepare("SELECT operation, source_revision FROM record_versions WHERE uri = ?")
        .bind(URI)
        .first<{ operation: string; source_revision: string }>();
      expect(version).toEqual({ operation: "delete", source_revision: "3" });
    }
  });

  it("versions record-filter exclusions so stale allowed records stay excluded", async () => {
    const resolved = config({
      collections: {
        event: {
          collection: COLLECTION,
          recordFilter: (record) => record.keep === true,
        },
      },
    });
    const db = await setup(resolved);
    const allowed = (revision: string, sourceTime: number, name: string) =>
      createIngestEvent({
        uri: URI,
        did: "did:plc:alice",
        collection: COLLECTION,
        rkey: "one",
        operation: "update",
        cid: `cid-${revision}`,
        value: { keep: true, name },
        timeUs: 10,
        indexedAt: sourceTime + 10_000,
        source: {
          id: "fake-source",
          time_us: sourceTime,
          revision,
          cursor: String(sourceTime),
        },
      });
    const excluded = createIngestEvent({
      uri: URI,
      did: "did:plc:alice",
      collection: COLLECTION,
      rkey: "one",
      operation: "update",
      cid: "cid-2",
      value: { keep: false, name: "excluded" },
      timeUs: 10,
      indexedAt: 10_200,
      source: {
        id: "fake-source",
        time_us: 200,
        revision: "2",
        cursor: "200",
      },
    });

    await ingestRecords(db, [allowed("1", 100, "old")], resolved);
    const exclusionResult = await ingestRecords(db, [excluded], resolved);
    expect(exclusionResult.accepted).toHaveLength(0);
    expect(exclusionResult.dropped.recordFilter).toBe(1);
    expect(await visibleName(db, resolved)).toBeUndefined();

    const stale = await ingestRecords(db, [allowed("1", 150, "stale")], resolved);
    expect(stale.dropped.superseded).toBe(1);
    expect(await visibleName(db, resolved)).toBeUndefined();

    await ingestRecords(db, [allowed("3", 300, "new")], resolved);
    expect(await visibleName(db, resolved)).toBe("new");
  });

  it("rolls record, tombstone metadata, and live cursor back together", async () => {
    const resolved = config();
    const db = await setup(resolved);
    await db.prepare("CREATE TABLE cursor_failure (value TEXT UNIQUE)").run();
    await db
      .prepare("INSERT INTO cursor_failure (value) VALUES ('duplicate')")
      .run();
    const orderedSource = { source: "jetstream", epoch: "atomic-test" };
    const event = mutation({
      operation: "create",
      sourceTime: 500,
      revision: "5",
      cid: "cid-five",
    });

    await expect(
      ingestRecords(db, [event], resolved, {
        trailingStatements: [
          saveCursorStatement(db, 500),
          saveOrderedSourcePositionStatement(db, orderedSource, 500),
          db.prepare("INSERT INTO cursor_failure (value) VALUES ('duplicate')"),
        ],
      }),
    ).rejects.toThrow();

    expect(await visibleName(db, resolved)).toBeUndefined();
    expect(
      await db
        .prepare("SELECT uri FROM record_versions WHERE uri = ?")
        .bind(URI)
        .first(),
    ).toBeNull();
    expect(
      await db.prepare("SELECT time_us FROM cursor WHERE id = 1").first(),
    ).toBeNull();
    expect(await getServingSourcePosition(db)).toBeNull();
  });

  it("stores record time separately from source and local times", async () => {
    const resolved = config();
    const db = await setup(resolved);
    await ingestRecords(
      db,
      [
        mutation({
          operation: "create",
          sourceTime: 500,
          revision: "5",
          cid: "cid-five",
          recordTime: 42,
        }),
      ],
      resolved,
    );

    const record = await db
      .prepare("SELECT time_us, indexed_at FROM records_event WHERE uri = ?")
      .bind(URI)
      .first<{ time_us: number; indexed_at: number }>();
    const version = await db
      .prepare("SELECT source_time_us, indexed_at FROM record_versions WHERE uri = ?")
      .bind(URI)
      .first<{ source_time_us: number; indexed_at: number }>();
    expect(record).toEqual({ time_us: 42, indexed_at: 10_500 });
    expect(version).toEqual({ source_time_us: 500, indexed_at: 10_500 });
  });
});
