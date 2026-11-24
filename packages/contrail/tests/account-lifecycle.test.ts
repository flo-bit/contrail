import { describe, expect, it, vi } from "vitest";
import type { JetstreamLiveEvent, Database } from "../src/index";
import { createTestDb, makeEvent, TEST_CONFIG } from "./helpers";
import {
  initSchema,
  ingestRecords,
  ingestEvents,
  runIngestCycle,
  runPersistent,
  queryRecords,
  getLastCursor,
} from "../src/index";
import { accountUpdateStatements } from "../src/core/moderation";
let events: JetstreamLiveEvent[] = [];
vi.mock("../src/core/jetstream-live", async (original) => ({
  ...(await original<typeof import("../src/core/jetstream-live")>()),
  JetstreamLiveSubscription: class {
    cursor = 0;
    async *[Symbol.asyncIterator]() {
      yield* events;
    }
  },
}));
vi.mock("../src/core/identity", async (original) => ({
  ...(await original<typeof import("../src/core/identity")>()),
  refreshStaleIdentities: vi.fn(),
}));
const did = "did:plc:test";
const account = (
  seq: number,
  active: boolean,
  status?: string,
  actor = did,
): JetstreamLiveEvent => ({
  kind: "account",
  seq,
  did: actor,
  time_us: seq * 1000,
  account: { did: actor, active, status },
});
async function setup() {
  const db = createTestDb();
  await initSchema(db, TEST_CONFIG);
  await ingestRecords(db, [makeEvent()], TEST_CONFIG);
  return db;
}
function failAccountOnce(db: Database): Database {
  const sql = new WeakMap<object, string>();
  let failed = false;
  return {
    dialect: db.dialect,
    prepare(query) {
      const s = db.prepare(query);
      sql.set(s, query);
      const bind = s.bind;
      s.bind = (...args) => {
        const bound = bind(...args);
        sql.set(bound, query);
        return bound;
      };
      return s;
    },
    batch(stmts) {
      if (
        !failed &&
        stmts.some((s) => sql.get(s)?.includes("INSERT INTO account_state"))
      ) {
        failed = true;
        throw new Error("lifecycle transaction failed");
      }
      return db.batch(stmts);
    },
  };
}

describe("live lifecycle checkpoints", () => {
  it("bounds account-only drains by their own budget, not the record budget", async () => {
    events = [
      account(1, false, undefined, "did:plc:a"),
      account(2, true, undefined, "did:plc:b"),
      account(3, false, undefined, "did:plc:c"),
    ];
    const result = await ingestEvents(TEST_CONFIG, 0, {
      maxCandidates: 1,
      maxAccountUpdates: 2,
    });
    expect(result.accountUpdates).toHaveLength(2);
    expect(result.lastCursor).toBe(2);
    expect(result.stats.stopReason).toBe("count");
  });
  it("network-wide account traffic for unknown actors does not spend the account budget", async () => {
    const db = await setup();
    events = [
      ...Array.from({ length: 150 }, (_, i) =>
        account(i + 1, false, "deactivated", `did:plc:stranger${i}`),
      ),
      account(151, false, "suspended"),
    ];
    const result = await ingestEvents(
      TEST_CONFIG,
      0,
      { maxAccountUpdates: 2 },
      undefined,
      async (dids) => new Set(dids.filter((d) => d === did)),
    );
    expect(result.accountUpdates).toEqual([
      expect.objectContaining({ did, cursor: 151 }),
    ]);
    expect(result.stats.accountUpdatesFiltered).toBe(150);
    expect(result.stats.stopReason).toBe("idle");
    expect(result.lastCursor).toBe(151);

    await runIngestCycle(db, TEST_CONFIG, { maxAccountUpdates: 2 });
    expect(await getLastCursor(db)).toBe(151);
    expect(
      (await db.prepare("SELECT did FROM account_state").all()).results,
    ).toEqual([{ did }]);
  });
  it("persistent ingestion drops unknown actors' account events before SQL", async () => {
    const db = await setup();
    const statements: string[] = [];
    const tracing: Database = {
      dialect: db.dialect,
      prepare(query) {
        statements.push(query);
        return db.prepare(query);
      },
      batch: (stmts) => db.batch(stmts),
    };
    const controller = new AbortController();
    await runPersistent(tracing, TEST_CONFIG, {
      signal: controller.signal,
      batchSize: 1,
      flushIntervalMs: 1_000,
      createSubscription: () => ({
        async *[Symbol.asyncIterator]() {
          yield account(1, false, "deactivated", "did:plc:stranger");
          yield account(2, false, "suspended");
          controller.abort();
        },
      }),
      logger: { log() {}, warn() {}, error() {} },
    });
    expect(await getLastCursor(db)).toBe(2);
    expect(
      statements.filter((s) => s.includes("INSERT INTO account_state")),
    ).toHaveLength(1);
    expect(
      (await db.prepare("SELECT did FROM account_state").all()).results,
    ).toEqual([{ did }]);
  });
  it("retains only the newest account event per actor", async () => {
    events = [account(1, false), account(2, true), account(3, false, "takendown")];
    const result = await ingestEvents(TEST_CONFIG, 0, { maxAccountUpdates: 2 });
    expect(result.accountUpdates).toEqual([
      expect.objectContaining({ did, cursor: 3, status: "takendown" }),
    ]);
    expect(result.lastCursor).toBe(3);
  });
  it("does not store lifecycle state for actors this instance holds no data for", async () => {
    const db = await setup();
    events = [
      account(1, false, "deactivated", "did:plc:stranger"),
      account(2, true, undefined, "did:plc:newcomer"),
    ];
    await runIngestCycle(db, TEST_CONFIG);
    expect(await getLastCursor(db)).toBe(2);
    expect(
      (await db.prepare("SELECT did FROM account_state").all()).results,
    ).toEqual([]);
  });
  it.each(["record", "identity"])(
    "initial active events for actors known by %s reject delayed inactive events",
    async (knownBy) => {
      const db = createTestDb();
      await initSchema(db, TEST_CONFIG);
      if (knownBy === "record") await ingestRecords(db, [makeEvent()], TEST_CONFIG);
      else await db.prepare("INSERT INTO identities (did, resolved_at) VALUES (?, 0)").bind(did).run();
      // An older drain can prepare its batch before a newer drain commits.
      const delayed = accountUpdateStatements(db, [
        { did, active: false, status: "deleted", timeUs: 10_000, cursor: 10 },
      ], TEST_CONFIG);
      events = [account(20, true)];
      await runIngestCycle(db, TEST_CONFIG);
      expect(await db.prepare("SELECT active, cursor FROM account_state WHERE did = ?").bind(did).first()).toEqual({ active: 1, cursor: 20 });
      await db.batch(delayed);
      await db.batch(accountUpdateStatements(db, [
        { did, active: false, status: "suspended", timeUs: 20_000, cursor: 20 },
      ], TEST_CONFIG));
      expect(await db.prepare("SELECT active, cursor FROM account_state WHERE did = ?").bind(did).first()).toEqual({ active: 1, cursor: 20 });
      expect(await db.prepare("SELECT 1 FROM moderation_hidden WHERE subject = ?").bind(did).first()).toBeNull();
      if (knownBy === "record") expect((await queryRecords(db, TEST_CONFIG, { collection: "event" })).records).toHaveLength(1);
      expect(await getLastCursor(db)).toBe(20);
    },
  );
  it("cron account-only batches store state with the exact cursor and reactivate", async () => {
    const db = await setup();
    events = [account(1, false, "deactivated")];
    await runIngestCycle(db, TEST_CONFIG);
    expect(
      (await queryRecords(db, TEST_CONFIG, { collection: "event" })).records,
    ).toEqual([]);
    expect(await getLastCursor(db)).toBe(1);
    events = [account(2, true)];
    await runIngestCycle(db, TEST_CONFIG);
    expect(
      (await queryRecords(db, TEST_CONFIG, { collection: "event" })).records,
    ).toHaveLength(1);
    expect(await getLastCursor(db)).toBe(2);
  });
  it("failed cron lifecycle transaction never checkpoints past an unpersisted account event", async () => {
    const db = await setup();
    events = [account(1, false, "deleted")];
    await expect(
      runIngestCycle(failAccountOnce(db), TEST_CONFIG),
    ).rejects.toThrow("lifecycle transaction failed");
    expect(await getLastCursor(db)).toBeNull();
    expect(await db.prepare("SELECT * FROM account_state").first()).toBeNull();
    await runIngestCycle(db, TEST_CONFIG);
    expect(await getLastCursor(db)).toBe(1);
  });
  it("persistent retries failed account-only buffers rather than losing them", async () => {
    const db = await setup();
    const controller = new AbortController();
    const lifecycle = account(10, false, "suspended");
    let subscriptions = 0;
    const timer = setTimeout(() => controller.abort(), 1_000);
    await runPersistent(failAccountOnce(db), TEST_CONFIG, {
      signal: controller.signal,
      batchSize: 1,
      flushIntervalMs: 20,
      createSubscription: () => ({
        async *[Symbol.asyncIterator]() {
          subscriptions++;
          yield lifecycle;
          // Account events flush on the timer: the first attempt fails and a
          // later tick must retry the retained buffer.
          await new Promise((resolve) => setTimeout(resolve, 100));
          controller.abort();
        },
      }),
      logger: { log() {}, warn() {}, error() {} },
    });
    clearTimeout(timer);
    expect(subscriptions).toBe(1);
    expect(await getLastCursor(db)).toBe(10);
    expect(
      (await queryRecords(db, TEST_CONFIG, { collection: "event" })).records,
    ).toEqual([]);
  });
});
