import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import {
  createIngestEvent,
  ingestRecords,
  initSchema,
  queryRecords,
  resolveConfig,
  type Database,
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
  });
});
