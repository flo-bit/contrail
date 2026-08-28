import { describe, expect, it } from "vitest";
import {
  createIngestEvent,
  getChangesStatus,
  ingestRecords,
  initSchema,
  resolveConfig,
  runChangeDeliverySlice,
  runPersistentChangeDeliveries,
  validateDeliveryHandlers,
  type ChangeConsumerConfig,
  type Database,
  type DeliveryHandlers,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { Contrail } from "../src/contrail";

const EVENT = "com.example.event";
const logger = { log() {}, warn() {}, error() {} };

function config(consumers: Record<string, ChangeConsumerConfig>) {
  return resolveConfig({
    namespace: "com.example",
    profiles: [],
    logger,
    collections: { event: { collection: EVENT } },
    changes: { consumers },
  });
}

function event(rkey: string, time: number) {
  const did = "did:plc:alice";
  return createIngestEvent({
    uri: `at://${did}/${EVENT}/${rkey}`,
    did,
    collection: EVENT,
    rkey,
    operation: "update",
    cid: `cid-${rkey}-${time}`,
    value: { name: rkey },
    timeUs: time,
    indexedAt: time + 10_000,
    source: {
      id: "source",
      epoch: "epoch",
      time_us: time,
      revision: String(time),
      cursor: String(time),
    },
  });
}

async function append(db: Database, resolved: ReturnType<typeof config>, rkey: string, time: number) {
  await ingestRecords(db, [event(rkey, time)], resolved);
}

describe("change delivery runtime", () => {
  it("fails startup for missing, extra, or incomplete runtime handlers", () => {
    const resolved = config({
      search: { collections: [EVENT], initial: "current" },
    });
    expect(() => validateDeliveryHandlers(resolved, {})).toThrow(
      "Missing runtime delivery handler",
    );
    expect(() =>
      validateDeliveryHandlers(resolved, { search: async () => {} }),
    ).toThrow("Missing current-state bootstrap handlers");
    expect(() =>
      validateDeliveryHandlers(
        resolved,
        { search: async () => {}, extra: async () => {} },
        {
          search: {
            snapshot: async () => {},
            activate: async () => {},
          },
        },
      ),
    ).toThrow("extra has no static consumer definition");
  });

  it("runs one bounded claim per consumer per fair round", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      alpha: { collections: [EVENT], initial: "history" },
      beta: { collections: [EVENT], initial: "history" },
      gamma: { collections: [EVENT], initial: "history" },
    });
    const contrail = new Contrail({ ...resolved, db });
    await contrail.init();
    await append(db, resolved, "one", 1);
    await append(db, resolved, "two", 2);

    const order: string[] = [];
    const handlers: DeliveryHandlers<{}> = Object.fromEntries(
      ["alpha", "beta", "gamma"].map((id) => [
        id,
        async () => {
          order.push(id);
        },
      ]),
    );
    const result = await runChangeDeliverySlice({
      changes: contrail.changes,
      config: resolved,
      db,
      env: {},
      deliveries: handlers,
      runtime: {
        maxRounds: 2,
        claim: { maxBatches: 1 },
        jitter: 0,
      },
    });
    expect(order).toEqual([
      "alpha",
      "beta",
      "gamma",
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(result).toMatchObject({
      delivered: 6,
      failures: 0,
      steps: 6,
    });
  });

  it("isolates one failing consumer and resumes it after persisted backoff", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      broken: { collections: [EVENT], initial: "history" },
      healthy: { collections: [EVENT], initial: "history" },
    });
    const contrail = new Contrail({ ...resolved, db });
    await contrail.init();
    await append(db, resolved, "one", 1);

    let fail = true;
    const handlers = {
      broken: async () => {
        if (fail) throw new Error("destination down");
      },
      healthy: async () => {},
    };
    let current = 1_000;
    const first = await runChangeDeliverySlice({
      changes: contrail.changes,
      config: resolved,
      db,
      env: {},
      deliveries: handlers,
      runtime: {
        maxRounds: 1,
        baseRetryMs: 100,
        maxRetryMs: 100,
        jitter: 0,
        clock: () => current,
      },
    });
    expect(first).toMatchObject({ delivered: 1, failures: 1 });
    let status = await getChangesStatus(db);
    expect(status.consumers.find((item) => item.id === "broken")).toMatchObject({
      position: "0",
      attempts: 1,
      nextAttemptAt: 1_100,
    });
    expect(status.consumers.find((item) => item.id === "healthy")).toMatchObject({
      position: "1",
    });

    fail = false;
    current = 1_101;
    const resumed = await runChangeDeliverySlice({
      changes: contrail.changes,
      config: resolved,
      db,
      env: {},
      deliveries: handlers,
      runtime: {
        maxRounds: 1,
        jitter: 0,
        clock: () => current,
      },
    });
    expect(resumed.delivered).toBe(1);
    status = await getChangesStatus(db);
    expect(status.consumers.find((item) => item.id === "broken")).toMatchObject({
      position: "1",
      attempts: 0,
    });
  });

  it("persists handler failure after the claim lease expires", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      webhook: { collections: [EVENT], initial: "history" },
    });
    const contrail = new Contrail({ ...resolved, db });
    await contrail.init();
    await append(db, resolved, "one", 1);

    let current = 100;
    const result = await runChangeDeliverySlice({
      changes: contrail.changes,
      config: resolved,
      db,
      env: {},
      deliveries: {
        webhook: async () => {
          current = 151;
          throw new Error("slow destination failure");
        },
      },
      runtime: {
        maxRounds: 1,
        claim: { leaseMs: 50 },
        baseRetryMs: 100,
        maxRetryMs: 100,
        jitter: 0,
        clock: () => current,
      },
    });

    expect(result).toMatchObject({ delivered: 0, failures: 1 });
    expect((await getChangesStatus(db)).consumers[0]).toMatchObject({
      position: "0",
      attempts: 1,
      nextAttemptAt: 251,
      lastErrorCode: "handler_error",
    });
  });

  it("drives current snapshot, catch-up, and idempotent activation", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      search: {
        collections: [EVENT],
        initial: "current",
        requiredForActivation: true,
      },
    });
    const contrail = new Contrail({ ...resolved, db });
    await contrail.init();
    await append(db, resolved, "one", 1);
    expect(
      await (
        await contrail.app().fetch(new Request("http://localhost/status"))
      ).json<any>(),
    ).toMatchObject({
      delivery: { required: "catching_up", pending: 1 },
    });

    const calls: string[] = [];
    const result = await runChangeDeliverySlice({
      changes: contrail.changes,
      config: resolved,
      db,
      env: { secret: "runtime-only" },
      deliveries: {
        search: async (batch, context) => {
          calls.push(`tail:${batch.cursor.through}:${context.env.secret}`);
        },
      },
      bootstraps: {
        search: {
          snapshot: async (page) => {
            expect(page).not.toHaveProperty("leaseOwner");
            calls.push(`snapshot:${page.records.length}`);
          },
          activate: async (activation) => {
            expect(activation).not.toHaveProperty("leaseOwner");
            calls.push(`activate:${activation.target}`);
          },
        },
      },
      runtime: { maxRounds: 6, jitter: 0 },
    });
    expect(calls).toEqual([
      "snapshot:1",
      "tail:1:runtime-only",
      "activate:1",
    ]);
    expect(result).toMatchObject({
      snapshotPages: 1,
      delivered: 1,
      activations: 1,
      failures: 0,
    });
    expect(await contrail.changes.bootstrapStatus("search")).toMatchObject({
      state: "ready",
      position: "1",
    });
    expect(
      await (
        await contrail.app().fetch(new Request("http://localhost/status"))
      ).json<any>(),
    ).toMatchObject({
      delivery: { required: "ready", pending: 0 },
    });
  });

  it("uses the configured lease for a slow activation", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      search: { collections: [EVENT], initial: "current" },
    });
    const contrail = new Contrail({ ...resolved, db });
    await contrail.init();
    await append(db, resolved, "one", 1);

    let current = 100;
    const result = await runChangeDeliverySlice({
      changes: contrail.changes,
      config: resolved,
      db,
      env: {},
      deliveries: { search: async () => {} },
      bootstraps: {
        search: {
          snapshot: async () => {},
          activate: async (activation) => {
            expect(activation.leaseExpiresAt).toBe(40_100);
            current = 31_100;
          },
        },
      },
      runtime: {
        maxRounds: 6,
        maxDurationMs: 60_000,
        claim: { leaseMs: 40_000 },
        jitter: 0,
        clock: () => current,
      },
    });

    expect(result).toMatchObject({ activations: 1, failures: 0 });
    expect(await contrail.changes.bootstrapStatus("search")).toMatchObject({
      state: "ready",
      position: "1",
    });
  });

  it("aborts destination work at the runtime deadline", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      webhook: { collections: [EVENT], initial: "history" },
    });
    const contrail = new Contrail({ ...resolved, db });
    await contrail.init();
    await append(db, resolved, "one", 1);
    let aborted = false;
    const result = await runChangeDeliverySlice({
      changes: contrail.changes,
      config: resolved,
      db,
      env: {},
      deliveries: {
        webhook: async (_batch, { signal }) => {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              aborted = true;
              resolve();
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
        },
      },
      runtime: { maxRounds: 1, maxDurationMs: 5 },
    });
    expect(aborted).toBe(true);
    expect(result.deadlineReached).toBe(true);
  });

  it("runs a persistent supervisor until cancellation", async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = config({
      webhook: { collections: [EVENT], initial: "history" },
    });
    const contrail = new Contrail({ ...resolved, db });
    await contrail.init();
    await append(db, resolved, "one", 1);
    const controller = new AbortController();
    let deliveries = 0;
    await runPersistentChangeDeliveries({
      changes: contrail.changes,
      config: resolved,
      db,
      env: {},
      deliveries: {
        webhook: async () => {
          deliveries++;
          controller.abort();
        },
      },
      runtime: {
        signal: controller.signal,
        idleMs: 1,
        maxRounds: 1,
      },
    });
    expect(deliveries).toBe(1);
    expect((await getChangesStatus(db)).consumers[0].position).toBe("1");
  });
});
