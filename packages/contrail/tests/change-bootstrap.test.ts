import { describe, expect, it } from "vitest";
import {
  acknowledgeChanges,
  acknowledgeCurrentSnapshotPage,
  claimChanges,
  claimCurrentActivation,
  claimCurrentBootstrapChanges,
  claimCurrentSnapshotPage,
  completeCurrentActivation,
  createIngestEvent,
  failCurrentSnapshotPage,
  getChangesStatus,
  getCurrentBootstrapStatus,
  getRequiredChangeConsumerReadiness,
  hydrateChanges,
  ingestRecords,
  initSchema,
  pruneChanges,
  resolveConfig,
  retryChangeConsumer,
  skipChangeConsumer,
  type ChangeConsumerConfig,
  type Database,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

const EVENT = "com.example.event";
const NOTE = "com.example.note";
const logger = { log() {}, warn() {}, error() {} };

function config(consumers: Record<string, ChangeConsumerConfig>) {
  return resolveConfig({
    namespace: "com.example",
    profiles: [],
    logger,
    collections: {
      event: { collection: EVENT },
      note: { collection: NOTE },
    },
    changes: { consumers },
  });
}

function event(options: {
  rkey: string;
  time: number;
  operation?: "create" | "update" | "delete";
  collection?: string;
  name?: string;
}) {
  const collection = options.collection ?? EVENT;
  const operation = options.operation ?? "update";
  const did = "did:plc:alice";
  return createIngestEvent({
    uri: `at://${did}/${collection}/${options.rkey}`,
    did,
    collection,
    rkey: options.rkey,
    operation,
    cid: operation === "delete" ? null : `cid-${options.rkey}-${options.time}`,
    value:
      operation === "delete"
        ? undefined
        : { name: options.name ?? `${options.rkey}-${options.time}` },
    timeUs: options.time,
    indexedAt: options.time + 10_000,
    source: {
      id: "source",
      epoch: "epoch",
      time_us: options.time,
      revision: String(options.time),
      cursor: String(options.time),
    },
  });
}

async function apply(db: Database, resolved: ReturnType<typeof config>, ...events: ReturnType<typeof event>[]) {
  await ingestRecords(db, events, resolved, { phase: "live" });
}

const keeper: ChangeConsumerConfig = {
  collections: [EVENT, NOTE],
  initial: "history",
};

describe("current-state change consumer bootstrap", () => {
  it("adds a current consumer over existing coverage and converges snapshot plus racing tail", async () => {
    const db = createSqliteDatabase(":memory:");
    const original = config({ keeper });
    await initSchema(db, original);
    await apply(
      db,
      original,
      event({ rkey: "a", time: 1, name: "a-one" }),
      event({ rkey: "b", time: 2, name: "b-one" }),
    );

    const withSearch = config({
      keeper,
      search: {
        collections: [EVENT],
        initial: "current",
        requiredForActivation: true,
      },
    });
    await initSchema(db, withSearch);
    let status = await getCurrentBootstrapStatus(db, "search");
    expect(status).toMatchObject({ state: "pending", anchor: "1", position: "1" });
    expect(status.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getRequiredChangeConsumerReadiness(db, "1")).toMatchObject({
      ready: false,
      pending: [expect.objectContaining({ id: "search", state: "pending" })],
    });

    const first = await claimCurrentSnapshotPage(db, withSearch, "search", {
      pageSize: 1,
      leaseMs: 10,
      now: 100,
    });
    expect(first?.records[0]).toMatchObject({
      rkey: "a",
      value: { name: "a-one" },
    });

    // Destination success followed by an ack crash replays the same stable page.
    const replay = await claimCurrentSnapshotPage(db, withSearch, "search", {
      pageSize: 1,
      leaseMs: 10,
      now: 111,
    });
    expect(replay?.pageId).toBe(first?.pageId);
    expect(replay?.bootstrapToken).toBe(first?.bootstrapToken);

    // Mutations after anchor M race the scan and must be corrected by the tail.
    await apply(
      db,
      withSearch,
      event({ rkey: "a", time: 3, name: "a-two" }),
      event({ rkey: "b", time: 4, operation: "delete" }),
      event({ rkey: "c", time: 5, name: "c-one" }),
    );
    await acknowledgeCurrentSnapshotPage(db, replay!, { now: 112 });

    let clock = 120;
    for (;;) {
      const page = await claimCurrentSnapshotPage(db, withSearch, "search", {
        pageSize: 1,
        now: clock++,
      });
      if (!page) break;
      await acknowledgeCurrentSnapshotPage(db, page, { now: clock++ });
    }
    status = await getCurrentBootstrapStatus(db, "search");
    expect(status).toMatchObject({
      state: "catching-up",
      anchor: "1",
      target: "2",
      position: "1",
    });

    const tail = await claimCurrentBootstrapChanges(db, "search", {
      now: 200,
    });
    expect(tail).toMatchObject({
      from: "1",
      through: "2",
      bootstrapTarget: "2",
      bootstrapToken: status.token,
    });
    const delivery = await hydrateChanges(db, withSearch, tail!);
    expect(delivery.destinationToken).toBe(status.token);
    expect(delivery.currentRecords.map((record) => record.rkey).sort()).toEqual([
      "a",
      "c",
    ]);
    expect(delivery.absentUris).toEqual([
      `at://did:plc:alice/${EVENT}/b`,
    ]);
    await acknowledgeChanges(db, tail!, { now: 201 });
    expect((await getCurrentBootstrapStatus(db, "search")).state).toBe(
      "activating",
    );

    const activation = await claimCurrentActivation(db, "search", {
      now: 300,
      leaseMs: 10,
    });
    const repeatedActivation = await claimCurrentActivation(db, "search", {
      now: 311,
      leaseMs: 10,
    });
    expect(repeatedActivation?.bootstrapToken).toBe(
      activation?.bootstrapToken,
    );
    await completeCurrentActivation(db, repeatedActivation!, { now: 312 });
    expect(await getCurrentBootstrapStatus(db, "search")).toMatchObject({
      state: "ready",
      position: "2",
      target: "2",
    });
    expect(await getRequiredChangeConsumerReadiness(db, "2")).toMatchObject({
      ready: true,
      pending: [],
    });

    await apply(db, withSearch, event({ rkey: "d", time: 6 }));
    const ordinary = await claimChanges(db, "search", { now: 400 });
    expect(ordinary).toMatchObject({ from: "2", through: "3" });
  });

  it("persists snapshot failure backoff and resumes the same page", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      keeper,
      search: { collections: [EVENT], initial: "current" },
    });
    await initSchema(db, resolved);
    await apply(db, resolved, event({ rkey: "a", time: 1 }));
    const page = await claimCurrentSnapshotPage(db, resolved, "search", {
      now: 100,
    });
    await failCurrentSnapshotPage(
      db,
      page!,
      { code: "destination_unavailable", nextAttemptAt: 200 },
      { now: 101 },
    );
    expect(
      await claimCurrentSnapshotPage(db, resolved, "search", { now: 150 }),
    ).toBeNull();
    await retryChangeConsumer(db, "search", { now: 150 });
    const retry = await claimCurrentSnapshotPage(db, resolved, "search", {
      now: 150,
    });
    expect(retry?.pageId).toBe(page?.pageId);
  });

  it("rejects additive consumers that require unlogged coverage", async () => {
    const db = createSqliteDatabase(":memory:");
    const eventOnly = config({
      keeper: { collections: [EVENT], phases: ["live"], initial: "history" },
    });
    await initSchema(db, eventOnly);
    const expanded = config({
      keeper: { collections: [EVENT], phases: ["live"], initial: "history" },
      notes: { collections: [NOTE], phases: ["live"], initial: "current" },
    });
    await expect(initSchema(db, expanded)).rejects.toThrow(
      "expands collection/phase coverage",
    );
  });
});

describe("consumer-aware change pruning", () => {
  it("requires explicit confirmation and audits an operator skip", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      blocked: { collections: [EVENT], initial: "history" },
    });
    await initSchema(db, resolved);
    for (let position = 1; position <= 3; position++) {
      await apply(db, resolved, event({ rkey: String(position), time: position }));
    }

    await expect(
      skipChangeConsumer(db, "blocked", {
        through: "2",
        reason: "destination was rebuilt out of band",
        confirm: false,
        now: 100,
      }),
    ).rejects.toThrow("confirm: true");
    await skipChangeConsumer(db, "blocked", {
      through: "2",
      reason: "destination was rebuilt out of band",
      confirm: true,
      now: 100,
    });
    expect((await getChangesStatus(db)).consumers[0]).toMatchObject({
      position: "2",
      lastErrorCode: expect.stringMatching(/^operator_skip:/),
    });
    expect(
      await db
        .prepare(
          `SELECT action, from_position, through_position, reason
           FROM change_consumer_actions`,
        )
        .first(),
    ).toEqual({
      action: "skip",
      from_position: 0,
      through_position: 2,
      reason: "destination was rebuilt out of band",
    });
  });

  it("prunes only through the slowest consumer in bounded resumable slices", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      fast: { collections: [EVENT], initial: "history" },
      slow: { collections: [EVENT], initial: "history" },
    });
    await initSchema(db, resolved);
    for (let position = 1; position <= 5; position++) {
      await apply(db, resolved, event({ rkey: String(position), time: position }));
    }

    const fast = await claimChanges(db, "fast", { now: 100 });
    await acknowledgeChanges(db, fast!, { now: 101 });
    const slowFirst = await claimChanges(db, "slow", {
      now: 100,
      maxBatches: 2,
    });
    await acknowledgeChanges(db, slowFirst!, { now: 101 });

    let pruned = await pruneChanges(db, { maxBatches: 10 });
    expect(pruned).toEqual({
      pruned: 2,
      retainedFloor: "2",
      safeThrough: "2",
      done: true,
    });
    expect((await getChangesStatus(db)).rows).toBe(3);

    const slowRest = await claimChanges(db, "slow", { now: 102 });
    await acknowledgeChanges(db, slowRest!, { now: 103 });
    pruned = await pruneChanges(db, { maxBatches: 2 });
    expect(pruned).toMatchObject({
      pruned: 2,
      retainedFloor: "4",
      safeThrough: "5",
      done: false,
    });
    pruned = await pruneChanges(db, { maxBatches: 2 });
    expect(pruned).toMatchObject({
      pruned: 1,
      retainedFloor: "5",
      safeThrough: "5",
      done: true,
    });
    expect((await getChangesStatus(db)).rows).toBe(0);

    // A later history consumer starts at the retained floor, never a deleted row.
    const withLate = config({
      fast: { collections: [EVENT], initial: "history" },
      slow: { collections: [EVENT], initial: "history" },
      late: { collections: [EVENT], initial: "history" },
    });
    await initSchema(db, withLate);
    expect(
      (await getChangesStatus(db)).consumers.find((item) => item.id === "late"),
    ).toMatchObject({ position: "5", backlogBatches: 0 });
  });
});
