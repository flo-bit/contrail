import { describe, expect, it } from "vitest";
import {
  Contrail,
  createIngestEvent,
  getChangeLogCostPlan,
  getChangeLogState,
  ingestRecords,
  initSchema,
  queryRecords,
  resolveConfig,
  saveCursorStatement,
  type ContrailConfig,
  type Database,
  type Statement,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

const EVENT = "com.example.event";
const NOTE = "com.example.note";
const URI = `at://did:plc:alice/${EVENT}/one`;
const logger = { log() {}, warn() {}, error() {} };

function config(options: {
  changes?: ContrailConfig["changes"];
  includeNote?: boolean;
} = {}) {
  return resolveConfig({
    namespace: "com.example",
    profiles: [],
    logger,
    collections: {
      event: { collection: EVENT },
      ...(options.includeNote ? { note: { collection: NOTE } } : {}),
    },
    changes: options.changes,
  });
}

function loggedConfig() {
  return config({
    changes: {
      consumers: {
        search: {
          collections: [EVENT],
          initial: "current",
          requiredForActivation: true,
        },
        webhooks: {
          collections: [EVENT],
          phases: ["live"],
          initial: "future",
        },
      },
    },
  });
}

function mutation(options: {
  sourceTime: number;
  cid?: string | null;
  value?: Record<string, unknown>;
  operation?: "create" | "update" | "delete";
  revision?: string | null;
}) {
  const operation = options.operation ?? "update";
  return createIngestEvent({
    uri: URI,
    did: "did:plc:alice",
    collection: EVENT,
    rkey: "one",
    operation,
    cid: operation === "delete" ? null : (options.cid ?? `cid-${options.sourceTime}`),
    value:
      operation === "delete"
        ? undefined
        : (options.value ?? { name: `event-${options.sourceTime}` }),
    timeUs: options.sourceTime,
    indexedAt: options.sourceTime + 10_000,
    source: {
      id: "source",
      epoch: "epoch",
      time_us: options.sourceTime,
      revision: options.revision ?? String(options.sourceTime),
      cursor: String(options.sourceTime),
    },
  });
}

async function batches(db: Database) {
  return (
    await db
      .prepare(
        `SELECT generation_id, position, projection_transaction_id, source_id,
                source_epoch, source_cursor, phase, changes_json, change_count
         FROM change_batches ORDER BY position`,
      )
      .all<any>()
  ).results;
}

describe("transactional projection change log", () => {
  it("validates bounded static consumer definitions", () => {
    const base = {
      namespace: "com.example",
      profiles: [] as string[],
      collections: { event: { collection: EVENT } },
    };
    expect(
      () =>
        new Contrail({
          ...base,
          changes: {
            consumers: {
              "bad id": { collections: [EVENT], initial: "future" },
            },
          },
        }),
    ).toThrow("Invalid change consumer ID");
    expect(
      () =>
        new Contrail({
          ...base,
          changes: {
            consumers: {
              search: { collections: ["event"], initial: "future" },
            },
          },
        }),
    ).toThrow("unconfigured collection NSID");
    expect(
      () =>
        new Contrail({
          ...base,
          changes: {
            consumers: {
              search: {
                collections: [EVENT],
                phases: ["live", "live"],
                initial: "future",
              },
            },
          },
        }),
    ).toThrow("unique historical/live phases");
    expect(
      () =>
        new Contrail({
          ...base,
          changes: {
            consumers: {
              search: {
                collections: [EVENT],
                phases: ["live"],
                initial: "current",
              },
            },
          },
        }),
    ).toThrow("must observe both historical and live phases");
  });

  it("has no change-log schema or writes when disabled", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config();
    expect(getChangeLogCostPlan(resolved, 50)).toEqual({
      enabled: false,
      consumers: 0,
      coveragePairs: 0,
      projectionStateWrites: 3,
      changeHeadWrites: 0,
      changeBatchWrites: 0,
      acknowledgementWrites: 0,
      relevantProjectionWrites: 3,
    });
    await initSchema(db, resolved);

    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'change_%' ORDER BY name",
      )
      .all<{ name: string }>();
    expect(tables.results).toEqual([]);
    expect(
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_contrail_projection_state'",
        )
        .first(),
    ).not.toBeNull();

    await ingestRecords(db, [mutation({ sourceTime: 1 })], resolved);
    expect(await getChangeLogState(db)).toBeNull();
  });

  it("initializes a fresh generation, registrations, and coverage ledger", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = loggedConfig();
    expect(getChangeLogCostPlan(resolved, 50)).toMatchObject({
      enabled: true,
      consumers: 2,
      coveragePairs: 2,
      projectionStateWrites: 3,
      changeHeadWrites: 1,
      changeBatchWrites: 1,
      acknowledgementWrites: 1,
      relevantProjectionWrites: 5,
    });
    await initSchema(db, resolved);

    const state = await getChangeLogState(db);
    expect(state).toMatchObject({ head: "0", retainedFloor: "0" });
    expect(state?.generation).toMatch(/^[0-9a-f-]{36}$/);

    const consumers = await db
      .prepare(
        `SELECT consumer_id, configured_collections_json,
                configured_phases_json, initial_mode,
                required_for_activation, bootstrap_state,
                acknowledged_position, bootstrap_anchor_position
         FROM change_consumers ORDER BY consumer_id`,
      )
      .all<any>();
    expect(consumers.results).toEqual([
      {
        consumer_id: "search",
        configured_collections_json: JSON.stringify([EVENT]),
        configured_phases_json: JSON.stringify(["historical", "live"]),
        initial_mode: "current",
        required_for_activation: 1,
        bootstrap_state: "pending",
        acknowledged_position: 0,
        bootstrap_anchor_position: 0,
      },
      {
        consumer_id: "webhooks",
        configured_collections_json: JSON.stringify([EVENT]),
        configured_phases_json: JSON.stringify(["live"]),
        initial_mode: "future",
        required_for_activation: 0,
        bootstrap_state: "ready",
        acknowledged_position: 0,
        bootstrap_anchor_position: null,
      },
    ]);

    const coverage = await db
      .prepare(
        `SELECT collection, phase, from_position, through_position
         FROM change_log_coverage ORDER BY collection, phase`,
      )
      .all<any>();
    expect(coverage.results).toEqual([
      {
        collection: EVENT,
        phase: "historical",
        from_position: 0,
        through_position: null,
      },
      {
        collection: EVENT,
        phase: "live",
        from_position: 0,
        through_position: null,
      },
    ]);

    // Initialization is idempotent and retains one random database generation.
    await initSchema(db, resolved);
    expect((await getChangeLogState(db))?.generation).toBe(state?.generation);
  });

  it("appends only committed logical current-state changes", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = loggedConfig();
    await initSchema(db, resolved);

    const original = mutation({
      sourceTime: 100,
      cid: "cid-one",
      value: { name: "one" },
    });
    await ingestRecords(db, [original], resolved, { phase: "historical" });
    expect((await getChangeLogState(db))?.head).toBe("1");

    // Exact replay and a newer source observation of the same immutable state
    // may update source metadata but do not wake current-state consumers.
    await ingestRecords(db, [original], resolved, { phase: "historical" });
    await ingestRecords(
      db,
      [
        mutation({
          sourceTime: 110,
          cid: "cid-one",
          value: { name: "one" },
        }),
      ],
      resolved,
      { phase: "live" },
    );
    expect((await getChangeLogState(db))?.head).toBe("1");

    await ingestRecords(
      db,
      [
        mutation({
          sourceTime: 200,
          cid: "cid-two",
          value: { name: "two" },
        }),
      ],
      resolved,
      { phase: "live" },
    );
    await ingestRecords(
      db,
      [mutation({ sourceTime: 300, operation: "delete" })],
      resolved,
      { phase: "live" },
    );
    await ingestRecords(
      db,
      [mutation({ sourceTime: 400, operation: "delete" })],
      resolved,
      { phase: "live" },
    );

    const rows = await batches(db);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.position, row.phase, row.change_count])).toEqual([
      [1, "historical", 1],
      [2, "live", 1],
      [3, "live", 1],
    ]);
    const changes = rows.map((row) => JSON.parse(row.changes_json)[0]);
    expect(changes[0]).toMatchObject({
      kind: "record",
      operation: "put",
      uri: URI,
      cid: "cid-one",
      version: { sourceId: "source", sourceTimeUs: 100 },
    });
    expect(changes[0]).not.toHaveProperty("id");
    expect(changes[0]).not.toHaveProperty("record");
    expect(changes[2]).toMatchObject({
      operation: "delete",
      uri: URI,
      cid: null,
    });
    expect((await getChangeLogState(db))?.head).toBe("3");
  });

  it("reduces multiple mutations for one URI to the final state", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = loggedConfig();
    await initSchema(db, resolved);

    await ingestRecords(
      db,
      [
        mutation({ sourceTime: 1, cid: "cid-one" }),
        mutation({ sourceTime: 2, cid: "cid-two" }),
        mutation({ sourceTime: 3, cid: "cid-three" }),
      ],
      resolved,
    );

    const rows = await batches(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].change_count).toBe(1);
    expect(JSON.parse(rows[0].changes_json)[0].cid).toBe("cid-three");
  });

  it("does not log a phase outside every consumer's coverage", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      changes: {
        consumers: {
          webhook: {
            collections: [EVENT],
            phases: ["live"],
            initial: "future",
          },
        },
      },
    });
    await initSchema(db, resolved);

    await ingestRecords(db, [mutation({ sourceTime: 1 })], resolved, {
      phase: "historical",
    });
    expect((await getChangeLogState(db))?.head).toBe("0");
    expect(await batches(db)).toEqual([]);
  });

  it("rolls projection, log head, batch, and checkpoint back together", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = loggedConfig();
    await initSchema(db, resolved);
    await db.prepare("CREATE TABLE change_failure (value TEXT UNIQUE)").run();
    await db.prepare("INSERT INTO change_failure VALUES ('duplicate')").run();

    await expect(
      ingestRecords(db, [mutation({ sourceTime: 1 })], resolved, {
        trailingStatements: [
          saveCursorStatement(db, 1),
          db.prepare("INSERT INTO change_failure VALUES ('duplicate')"),
        ],
      }),
    ).rejects.toThrow();

    expect((await getChangeLogState(db))?.head).toBe("0");
    expect(await batches(db)).toEqual([]);
    expect(
      await db.prepare("SELECT uri FROM records_event").first(),
    ).toBeNull();
    expect(await db.prepare("SELECT time_us FROM cursor").first()).toBeNull();
  });

  it("gives each fresh database a distinct generation", async () => {
    const resolved = loggedConfig();
    const first = createSqliteDatabase(":memory:");
    const second = createSqliteDatabase(":memory:");
    await initSchema(first, resolved);
    await initSchema(second, resolved);
    expect((await getChangeLogState(first))?.generation).not.toBe(
      (await getChangeLogState(second))?.generation,
    );
  });

  it("matches durable consumer IDs independently of locale sort order", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      changes: {
        consumers: {
          a_: { collections: [EVENT], initial: "future" },
          "a-": { collections: [EVENT], initial: "future" },
        },
      },
    });

    await initSchema(db, resolved);
    await expect(initSchema(db, resolved)).resolves.toBeUndefined();
    const rows = await db
      .prepare("SELECT consumer_id FROM change_consumers ORDER BY consumer_id")
      .all<{ consumer_id: string }>();
    expect(rows.results.map((row) => row.consumer_id)).toEqual(["a-", "a_"]);
  });

  it("fails closed for unsafe enable, disable, and definition changes", async () => {
    const populated = createSqliteDatabase(":memory:");
    const disabled = config();
    await initSchema(populated, disabled);
    await ingestRecords(populated, [mutation({ sourceTime: 1 })], disabled);
    await expect(initSchema(populated, loggedConfig())).rejects.toThrow(
      "fresh empty generation",
    );
    expect(
      await populated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='change_log_state'",
        )
        .first(),
    ).toBeNull();

    const initialized = createSqliteDatabase(":memory:");
    await initSchema(initialized, loggedConfig());
    await expect(initSchema(initialized, config())).rejects.toThrow(
      "cannot be disabled",
    );
    const changed = config({
      changes: {
        consumers: {
          replacement: { collections: [EVENT], initial: "future" },
        },
      },
    });
    await expect(initSchema(initialized, changed)).rejects.toThrow(
      "cannot be removed or modified",
    );
  });

  it("upgrades retained pre-byte-count change batches without resetting consumers", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = loggedConfig();
    await initSchema(db, resolved);
    await ingestRecords(db, [mutation({ sourceTime: 1 })], resolved);
    await db
      .prepare("ALTER TABLE change_batches DROP COLUMN encoded_bytes")
      .run();
    await db
      .prepare(
        "UPDATE _contrail_meta SET value = 'old-change-schema' WHERE key = 'schema_fingerprint'",
      )
      .run();

    await initSchema(db, resolved);
    const row = await db
      .prepare("SELECT encoded_bytes, changes_json FROM change_batches")
      .first<{ encoded_bytes: number; changes_json: string }>();
    expect(row?.encoded_bytes).toBe(
      new TextEncoder().encode(row!.changes_json).byteLength,
    );
    expect((await getChangeLogState(db))?.head).toBe("1");
  });

  it("retries a losing overlapping writer from fresh durable state", async () => {
    const real = createSqliteDatabase(":memory:");
    const resolved = loggedConfig();
    await initSchema(real, resolved);

    let arrivals = 0;
    let releaseBoth!: () => void;
    const both = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    let releaseNewer!: () => void;
    const newerDone = new Promise<void>((resolve) => {
      releaseNewer = resolve;
    });

    function overlapping(role: "older" | "newer"): Database {
      let projectionBatches = 0;
      return {
        prepare(sql: string): Statement {
          return real.prepare(sql);
        },
        async batch(statements: Statement[]) {
          projectionBatches++;
          if (projectionBatches > 1) return real.batch(statements);
          arrivals++;
          if (arrivals === 2) releaseBoth();
          await both;
          if (role === "older") await newerDone;
          try {
            return await real.batch(statements);
          } finally {
            if (role === "newer") releaseNewer();
          }
        },
        dialect: real.dialect,
      };
    }

    const olderDb = overlapping("older");
    const newerDb = overlapping("newer");
    const [older] = await Promise.all([
      ingestRecords(
        olderDb,
        [mutation({ sourceTime: 100, cid: "cid-old", value: { name: "old" } })],
        resolved,
        { trailingStatements: [saveCursorStatement(real, 100)] },
      ),
      ingestRecords(
        newerDb,
        [mutation({ sourceTime: 200, cid: "cid-new", value: { name: "new" } })],
        resolved,
        { trailingStatements: [saveCursorStatement(real, 200)] },
      ),
    ]);

    expect(older.dropped.superseded).toBe(1);
    const visible = await queryRecords(real, resolved, { collection: "event" });
    expect(JSON.parse(visible.records[0]!.record!).name).toBe("new");
    expect((await getChangeLogState(real))?.head).toBe("1");
    expect(JSON.parse((await batches(real))[0].changes_json)[0].cid).toBe(
      "cid-new",
    );
    expect(
      await real.prepare("SELECT time_us FROM cursor WHERE id = 1").first(),
    ).toEqual({ time_us: 200 });
  });
});
