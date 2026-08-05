import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import {
  createIngestEvent,
  ingestRecords,
  initSchema,
  queryRecords,
  resolveConfig,
  type Database,
  type Statement,
} from "../src/index";

const logger = { log() {}, warn() {}, error() {} };

const config = resolveConfig({
  namespace: "com.example",
  logger,
  collections: {
    event: {
      collection: "com.example.event",
      recordFilter: (record) => record.keep === true,
    },
    follow: {
      collection: "app.bsky.graph.follow",
      discover: false,
      subjectField: "subject",
    },
    directedEvent: {
      collection: "com.example.directedEvent",
      subjectField: "subject",
    },
  },
});

let db: Database;

beforeEach(async () => {
  db = createSqliteDatabase(":memory:");
  await initSchema(db, config);
});

describe("ingestRecords", () => {
  it("is the shared recordFilter admission path", async () => {
    const result = await ingestRecords(
      db,
      [
        createIngestEvent({
          did: "did:plc:alice",
          collection: "com.example.event",
          rkey: "kept",
          operation: "create",
          cid: "cid-kept",
          value: { keep: true },
          timeUs: 1,
        }),
        createIngestEvent({
          did: "did:plc:alice",
          collection: "com.example.event",
          rkey: "dropped",
          operation: "create",
          cid: "cid-dropped",
          value: { keep: false },
          timeUs: 2,
        }),
      ],
      config,
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.dropped.recordFilter).toBe(1);
    const stored = await queryRecords(db, config, { collection: "event" });
    expect(stored.records.map((record) => record.rkey)).toEqual(["kept"]);
  });

  it("packs record writes into statements within D1's binding limit", async () => {
    const sql: string[] = [];
    const observedDb: Database = {
      prepare(statement) {
        sql.push(statement);
        return db.prepare(statement);
      },
      batch(statements: Statement[]) {
        return db.batch(statements);
      },
      dialect: db.dialect,
    };
    const events = Array.from({ length: 30 }, (_, index) =>
      createIngestEvent({
        did: "did:plc:alice",
        collection: "com.example.event",
        rkey: `bulk-${index}`,
        operation: "create",
        cid: `cid-${index}`,
        value: { keep: true },
        timeUs: index + 1,
      }),
    );

    await ingestRecords(observedDb, events, config);

    const inserts = sql.filter((statement) =>
      statement.startsWith("INSERT INTO records_event"),
    );
    expect(inserts).toHaveLength(3);
    expect(inserts.every((statement) => (statement.match(/\?/g) ?? []).length <= 100)).toBe(true);
    const versionInserts = sql.filter((statement) =>
      statement.startsWith("INSERT INTO record_versions"),
    );
    expect(versionInserts).toHaveLength(4);
    expect(
      versionInserts.every(
        (statement) => (statement.match(/\?/g) ?? []).length <= 100,
      ),
    ).toBe(true);
    expect((await queryRecords(db, config, { collection: "event" })).records).toHaveLength(30);
  });

  it("commits trailing checkpoint statements atomically with projection", async () => {
    await db.prepare("CREATE TABLE checkpoint_test (value TEXT UNIQUE)").run();
    await db
      .prepare("INSERT INTO checkpoint_test (value) VALUES (?)")
      .bind("duplicate")
      .run();
    const event = createIngestEvent({
      did: "did:plc:alice",
      collection: "com.example.event",
      rkey: "atomic",
      operation: "create",
      cid: "cid-atomic",
      value: { keep: true },
      timeUs: 1,
    });

    await expect(
      ingestRecords(db, [event], config, {
        trailingStatements: [
          db
            .prepare("INSERT INTO checkpoint_test (value) VALUES (?)")
            .bind("duplicate"),
        ],
      })
    ).rejects.toThrow();

    expect(
      (await queryRecords(db, config, { collection: "event" })).records
    ).toHaveLength(0);
  });

  it("drops malformed records and untracked collections before projection", async () => {
    const malformed = createIngestEvent({
      did: "did:plc:alice",
      collection: "com.example.event",
      rkey: "bad",
      operation: "create",
      cid: "cid-bad",
      value: { keep: true },
      timeUs: 1,
    });
    malformed.record = "not json";

    const result = await ingestRecords(
      db,
      [
        malformed,
        createIngestEvent({
          did: "did:plc:alice",
          collection: "com.example.unknown",
          rkey: "unknown",
          operation: "create",
          cid: "cid-unknown",
          value: {},
          timeUs: 2,
        }),
      ],
      config,
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.dropped.invalidRecord).toBe(1);
    expect(result.dropped.unknownCollection).toBe(1);
  });

  it("does not apply dependent subject filtering to discoverable collections", async () => {
    const event = createIngestEvent({
      did: "did:plc:alice",
      collection: "com.example.directedEvent",
      rkey: "public",
      operation: "create",
      cid: "cid-public",
      value: { subject: "did:plc:unknown" },
      timeUs: 1,
    });

    const result = await ingestRecords(db, [event], config);
    expect(result.accepted).toEqual([event]);
    expect(result.dropped.unknownSubject).toBe(0);
  });

  it("admits dependent records discovered in the same batch regardless of order", async () => {
    for (const dependentFirst of [false, true]) {
      const suffix = dependentFirst ? "dependent-first" : "primary-first";
      const primary = createIngestEvent({
        did: `did:plc:${suffix}`,
        collection: "com.example.event",
        rkey: suffix,
        operation: "create",
        cid: `cid-${suffix}`,
        value: { keep: true },
        timeUs: 1,
      });
      const follow = createIngestEvent({
        did: `did:plc:${suffix}`,
        collection: "app.bsky.graph.follow",
        rkey: suffix,
        operation: "create",
        cid: `follow-${suffix}`,
        value: { subject: `did:plc:${suffix}` },
        timeUs: 2,
      });

      const result = await ingestRecords(
        db,
        dependentFirst ? [follow, primary] : [primary, follow],
        config,
        { knownDids: new Set() },
      );
      expect(result.accepted).toHaveLength(2);
      expect(result.discoveredDids).toEqual([`did:plc:${suffix}`]);
    }
  });

  it("does not let a rejected primary admit dependent records", async () => {
    const result = await ingestRecords(
      db,
      [
        createIngestEvent({
          did: "did:plc:rejected",
          collection: "com.example.event",
          rkey: "primary",
          operation: "create",
          cid: "primary-cid",
          value: { keep: false },
          timeUs: 1,
        }),
        createIngestEvent({
          did: "did:plc:rejected",
          collection: "app.bsky.graph.follow",
          rkey: "follow",
          operation: "create",
          cid: "follow-cid",
          value: { subject: "did:plc:known" },
          timeUs: 2,
        }),
      ],
      config,
      { knownDids: new Set(["did:plc:known"]) },
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.dropped.recordFilter).toBe(1);
    expect(result.dropped.unknownActor).toBe(1);
  });

  it("applies dependent subject filtering in the same admission path", async () => {
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind("did:plc:known", null, null, 1)
      .run();

    const records = ["did:plc:known", "did:plc:unknown"].map(
      (subject, index) =>
        createIngestEvent({
          did: "did:plc:alice",
          collection: "app.bsky.graph.follow",
          rkey: `f${index}`,
          operation: "create",
          cid: `cid-${index}`,
          value: { subject },
          timeUs: index + 1,
        }),
    );

    const result = await ingestRecords(db, records, config);
    expect(result.accepted.map((record) => record.rkey)).toEqual(["f0"]);
    expect(result.dropped.unknownSubject).toBe(1);
    expect(
      await db
        .prepare("SELECT uri FROM record_versions WHERE uri = ?")
        .bind(records[1].uri)
        .first(),
    ).toBeNull();
  });

  it("always admits deletes when another mutation for the same URI is filtered", async () => {
    const uri = "at://did:plc:alice/app.bsky.graph.follow/shared";
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind("did:plc:known", null, null, 1)
      .run();
    await ingestRecords(
      db,
      [
        createIngestEvent({
          uri,
          did: "did:plc:alice",
          collection: "app.bsky.graph.follow",
          rkey: "shared",
          operation: "create",
          cid: "old-cid",
          value: { subject: "did:plc:known" },
          timeUs: 1,
        }),
      ],
      config,
    );

    const update = createIngestEvent({
      uri,
      did: "did:plc:alice",
      collection: "app.bsky.graph.follow",
      rkey: "shared",
      operation: "update",
      cid: "new-cid",
      value: { subject: "did:plc:unknown" },
      timeUs: 2,
    });
    const deletion = createIngestEvent({
      uri,
      did: "did:plc:alice",
      collection: "app.bsky.graph.follow",
      rkey: "shared",
      operation: "delete",
      timeUs: 3,
    });
    const result = await ingestRecords(db, [update, deletion], config);

    expect(result.accepted).toEqual([deletion]);
    expect(result.dropped.unknownSubject).toBe(0);
    expect(result.dropped.superseded).toBe(1);
    const stored = await queryRecords(db, config, { collection: "follow" });
    expect(stored.records).toHaveLength(0);
  });
});
