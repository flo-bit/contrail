import { describe, expect, it } from "vitest";
import {
  ChangeClaimTooLargeError,
  ChangeLeaseLostError,
  acknowledgeChanges,
  claimChanges,
  createIngestEvent,
  failChanges,
  getChangesStatus,
  hydrateChanges,
  ingestRecords,
  initSchema,
  registerChangeConsumer,
  renewChangeClaim,
  resolveConfig,
  retryChangeConsumer,
  type ChangeClaim,
  type ContrailConfig,
  type Database,
  type ProjectionPhase,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

const EVENT = "com.example.event";
const NOTE = "com.example.note";
const logger = { log() {}, warn() {}, error() {} };

function consumerConfig(
  consumers: NonNullable<ContrailConfig["changes"]>["consumers"],
) {
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

function mutation(options: {
  collection?: string;
  rkey: string;
  sourceTime: number;
  cid?: string;
  name?: string;
  operation?: "create" | "update" | "delete";
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
    cid: operation === "delete" ? null : (options.cid ?? `cid-${options.sourceTime}`),
    value:
      operation === "delete"
        ? undefined
        : { name: options.name ?? `${options.rkey}-${options.sourceTime}` },
    timeUs: options.sourceTime,
    indexedAt: options.sourceTime + 10_000,
    source: {
      id: "source",
      epoch: "epoch",
      time_us: options.sourceTime,
      revision: String(options.sourceTime),
      cursor: String(options.sourceTime),
    },
  });
}

async function apply(
  db: Database,
  config: ReturnType<typeof consumerConfig>,
  events: ReturnType<typeof mutation>[],
  phase: ProjectionPhase = "live",
) {
  await ingestRecords(db, events, config, { phase });
}

function readyEventConsumer(id = "search") {
  return consumerConfig({
    [id]: {
      collections: [EVENT],
      initial: "history",
    },
  });
}

describe("durable change consumers", () => {
  it("verifies static registration and keeps current consumers pending", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = consumerConfig({
      search: { collections: [EVENT], initial: "current" },
      webhook: { collections: [EVENT], phases: ["live"], initial: "future" },
    });
    await initSchema(db, config);

    await expect(registerChangeConsumer(db, config, "search")).resolves.toBeUndefined();
    await expect(registerChangeConsumer(db, config, "missing")).rejects.toThrow(
      "not configured",
    );
    await apply(db, config, [mutation({ rkey: "one", sourceTime: 1 })]);
    expect(await claimChanges(db, "search", { now: 100 })).toBeNull();
    expect(await claimChanges(db, "webhook", { now: 100 })).not.toBeNull();
  });

  it("claims a bounded range, coalesces URIs, hydrates current state, and acks with CAS", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = readyEventConsumer();
    await initSchema(db, config);
    await apply(
      db,
      config,
      [mutation({ rkey: "one", sourceTime: 1, cid: "cid-one", name: "one" })],
      "historical",
    );
    await apply(db, config, [
      mutation({ rkey: "one", sourceTime: 2, cid: "cid-two", name: "two" }),
    ]);

    const claim = await claimChanges(db, "search", { now: 1_000 });
    expect(claim).toMatchObject({
      consumerId: "search",
      from: "0",
      through: "2",
      attempt: 1,
    });
    expect(claim!.changes).toHaveLength(1);
    expect(claim!.changes[0]).toMatchObject({
      id: `${claim!.generation}:2:0`,
      uri: `at://did:plc:alice/${EVENT}/one`,
      cid: "cid-two",
    });

    const delivery = await hydrateChanges(db, config, claim!);
    expect(delivery.cursor).toEqual({
      generation: claim!.generation,
      from: "0",
      through: "2",
    });
    expect(delivery.currentRecords).toHaveLength(1);
    expect(delivery.currentRecords[0]).toMatchObject({
      cid: "cid-two",
      value: { name: "two" },
    });
    expect(delivery.absentUris).toEqual([]);

    await acknowledgeChanges(db, claim!, { now: 1_001 });
    await expect(
      acknowledgeChanges(db, claim!, { now: 1_002 }),
    ).rejects.toBeInstanceOf(ChangeLeaseLostError);
    expect(await claimChanges(db, "search", { now: 1_003 })).toBeNull();

    const status = await getChangesStatus(db);
    expect(status).toMatchObject({ enabled: true, rows: 2, changes: 2 });
    expect(status.consumers[0]).toMatchObject({
      id: "search",
      position: "2",
      backlogBatches: 0,
      attempts: 0,
      leased: false,
    });

    // Unrelated schema migrations must preserve mutable consumer progress.
    await db
      .prepare(
        "UPDATE _contrail_meta SET value = 'stale' WHERE key = 'schema_fingerprint'",
      )
      .run();
    await initSchema(db, config);
    expect((await getChangesStatus(db)).consumers[0].position).toBe("2");
  });

  it("hydrates newest state when delete/recreate races a claimed change", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = readyEventConsumer();
    await initSchema(db, config);
    await apply(db, config, [mutation({ rkey: "one", sourceTime: 1 })]);
    const claim = await claimChanges(db, "search", { now: 100 });

    await apply(db, config, [
      mutation({ rkey: "one", sourceTime: 2, operation: "delete" }),
    ]);
    let delivery = await hydrateChanges(db, config, claim!);
    expect(delivery.currentRecords).toEqual([]);
    expect(delivery.absentUris).toEqual([
      `at://did:plc:alice/${EVENT}/one`,
    ]);

    await apply(db, config, [
      mutation({ rkey: "one", sourceTime: 3, cid: "cid-three", name: "three" }),
    ]);
    delivery = await hydrateChanges(db, config, claim!);
    expect(delivery.absentUris).toEqual([]);
    expect(delivery.currentRecords[0]).toMatchObject({
      cid: "cid-three",
      value: { name: "three" },
    });
  });

  it("leases independently, persists failure backoff, and manually retries", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = consumerConfig({
      search: { collections: [EVENT], initial: "history" },
      analytics: { collections: [EVENT], initial: "history" },
    });
    await initSchema(db, config);
    await apply(db, config, [mutation({ rkey: "one", sourceTime: 1 })]);

    const search = await claimChanges(db, "search", { now: 1_000 });
    const analytics = await claimChanges(db, "analytics", { now: 1_000 });
    expect(search?.leaseOwner).not.toBe(analytics?.leaseOwner);

    expect(
      await failChanges(
        db,
        search!,
        { code: "destination_unavailable", nextAttemptAt: 2_000 },
        { now: 1_001 },
      ),
    ).toEqual({ attempts: 1, nextAttemptAt: 2_000 });
    await acknowledgeChanges(db, analytics!, { now: 1_001 });

    expect(await claimChanges(db, "search", { now: 1_500 })).toBeNull();
    await retryChangeConsumer(db, "search", { now: 1_500 });
    const retry = await claimChanges(db, "search", { now: 1_500 });
    expect(retry?.attempt).toBe(2);
    await acknowledgeChanges(db, retry!, { now: 1_501 });

    const status = await getChangesStatus(db);
    expect(status.consumers.find((item) => item.id === "analytics")).toMatchObject({
      position: "1",
      attempts: 0,
    });
    expect(status.consumers.find((item) => item.id === "search")).toMatchObject({
      position: "1",
      attempts: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
    });
  });

  it("allows only one concurrent lease and rejects a replaced owner", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = readyEventConsumer();
    await initSchema(db, config);
    await apply(db, config, [mutation({ rkey: "one", sourceTime: 1 })]);

    const claims = await Promise.all([
      claimChanges(db, "search", { now: 100, leaseMs: 50 }),
      claimChanges(db, "search", { now: 100, leaseMs: 50 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const stale = claims.find(Boolean)!;
    const replacement = await claimChanges(db, "search", {
      now: 151,
      leaseMs: 50,
    });
    expect(replacement?.leaseOwner).not.toBe(stale.leaseOwner);
    expect(replacement?.changes.map((change) => change.id)).toEqual(
      stale.changes.map((change) => change.id),
    );
    await expect(
      acknowledgeChanges(db, stale, { now: 152 }),
    ).rejects.toBeInstanceOf(ChangeLeaseLostError);
    await expect(
      failChanges(
        db,
        stale,
        { code: "stale_failure", nextAttemptAt: 300 },
        { now: 152 },
      ),
    ).rejects.toBeInstanceOf(ChangeLeaseLostError);
    await acknowledgeChanges(db, replacement!, { now: 152 });
  });

  it("renews a live lease without changing its CAS owner", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = readyEventConsumer();
    await initSchema(db, config);
    await apply(db, config, [mutation({ rkey: "one", sourceTime: 1 })]);
    const claim = await claimChanges(db, "search", {
      now: 100,
      leaseMs: 50,
    });
    const renewed = await renewChangeClaim(db, claim!, {
      now: 120,
      leaseMs: 100,
    });
    expect(renewed.leaseOwner).toBe(claim!.leaseOwner);
    expect(renewed.leaseExpiresAt).toBe(220);
    await acknowledgeChanges(db, renewed, { now: 200 });
  });

  it("auto-advances irrelevant ranges while preserving independent progress", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = consumerConfig({
      events: { collections: [EVENT], phases: ["live"], initial: "future" },
      notes: { collections: [NOTE], phases: ["live"], initial: "future" },
    });
    await initSchema(db, config);
    await apply(db, config, [
      mutation({ collection: NOTE, rkey: "note", sourceTime: 1 }),
    ]);
    await apply(db, config, [mutation({ rkey: "event", sourceTime: 2 })]);

    const eventClaim = await claimChanges(db, "events", {
      now: 100,
      maxBatches: 1,
    });
    expect(eventClaim).toMatchObject({ from: "1", through: "2" });
    expect(eventClaim!.changes[0].collection).toBe(EVENT);
    await acknowledgeChanges(db, eventClaim!, { now: 101 });

    const noteClaim = await claimChanges(db, "notes", { now: 100 });
    expect(noteClaim).toMatchObject({ from: "0", through: "2" });
    expect(noteClaim!.changes[0].collection).toBe(NOTE);
    await acknowledgeChanges(db, noteClaim!, { now: 101 });
  });

  it("releases a lease when the first durable batch exceeds claim limits", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = readyEventConsumer();
    await initSchema(db, config);
    await apply(db, config, [
      mutation({ rkey: "one", sourceTime: 1 }),
      mutation({ rkey: "two", sourceTime: 2 }),
    ]);

    await expect(
      claimChanges(db, "search", { now: 100, maxChanges: 1 }),
    ).rejects.toBeInstanceOf(ChangeClaimTooLargeError);
    const claim = await claimChanges(db, "search", {
      now: 101,
      maxChanges: 2,
    });
    expect(claim?.changes).toHaveLength(2);
  });

  it("rejects forged generation cursors and never regresses a checkpoint", async () => {
    const db = createSqliteDatabase(":memory:");
    const config = readyEventConsumer();
    await initSchema(db, config);
    await apply(db, config, [mutation({ rkey: "one", sourceTime: 1 })]);
    const claim = await claimChanges(db, "search", { now: 100 });
    const forged: ChangeClaim = { ...claim!, generation: crypto.randomUUID() };
    await expect(
      acknowledgeChanges(db, forged, { now: 101 }),
    ).rejects.toBeInstanceOf(ChangeLeaseLostError);
    await acknowledgeChanges(db, claim!, { now: 101 });
    expect((await getChangesStatus(db)).consumers[0].position).toBe("1");
  });
});
