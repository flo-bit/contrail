import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeEvent, TEST_CONFIG } from "./helpers";
import {
  ingestRecords,
  initSchema,
  queryRecords,
  resolveConfig,
} from "../src/index";
import { labelBackfillEnqueueStatements } from "../src/core/moderation";
import { runLabelBackfillQueue } from "../src/core/moderation-sync";
import type { Database } from "../src/index";

const src = "did:plc:external";
const did = "did:plc:test";
const label = { src, uri: did, val: "!hide", cts: "2026-01-01T00:00:00Z" };

function policy(values: string[]) {
  return resolveConfig({
    ...TEST_CONFIG,
    profiles: [],
    logger: { log() {}, warn() {}, error() {} },
    labels: {
      sources: [{ did: src, endpoint: "https://labels.example", subjects: "known", enforce: true, values }],
    },
  });
}

async function setup(values: string[]) {
  const db = createTestDb();
  const config = policy(values);
  await initSchema(db, config);
  await ingestRecords(db, [makeEvent()], config);
  await db.prepare("INSERT INTO identities (did, resolved_at) VALUES (?, 0)").bind(did).run();
  return { db, config };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delayedFetch() {
  const started = deferred<void>();
  const response = deferred<Response>();
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => { started.resolve(); return response.promise; })
    .mockImplementation(async () => Response.json({ labels: [label] }));
  return { started: started.promise, response, fetch };
}

async function queue(db: Database) {
  return db.prepare("SELECT * FROM label_backfill_queue WHERE src = ? AND did = ?").bind(src, did).first<any>();
}

async function visible(db: Database, config: ReturnType<typeof policy>) {
  return (await queryRecords(db, config, { collection: "event" })).records.length;
}

async function storedLabels(db: Database) {
  return (await db.prepare("SELECT val, neg FROM labels WHERE src = ?").bind(src).all()).results;
}

afterEach(() => vi.restoreAllMocks());

describe("label backfill queue", () => {
  it("preserves a first-identity reset, including an unchanged null cursor", async () => {
    const { db, config } = await setup(["!hide"]);
    const delayed = delayedFetch();
    const work = runLabelBackfillQueue(db, config);
    await delayed.started;
    const before = await queue(db);
    await db.prepare("DELETE FROM identities WHERE did = ?").bind(did).run();
    await db.batch([
      ...labelBackfillEnqueueStatements(db, [did], config, true),
      db.prepare("INSERT INTO identities (did, resolved_at) VALUES (?, 0)").bind(did),
    ]);
    const reset = await queue(db);
    expect(reset.generation).toBe(before.generation + 1);
    expect(reset.cursor).toBeNull();
    delayed.response.resolve(Response.json({ labels: [label] }));
    await work;
    expect(await queue(db)).toEqual(reset);
    await runLabelBackfillQueue(db, config);
    expect((await queue(db)).completed).toBe(1);
    expect(await visible(db, config)).toBe(0);
  });

  it("does not overwrite a newer worker's checkpoint on late completion", async () => {
    const { db, config } = await setup(["!hide"]);
    const first = deferred<Response>();
    const second = deferred<Response>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => { firstStarted.resolve(); return first.promise; })
      .mockImplementationOnce(() => { secondStarted.resolve(); return second.promise; });
    const oldWork = runLabelBackfillQueue(db, config);
    await firstStarted.promise;
    const newWork = runLabelBackfillQueue(db, config);
    await secondStarted.promise;
    second.resolve(Response.json({ labels: [label], cursor: "page2" }));
    await newWork;
    const advanced = await queue(db);
    first.resolve(Response.json({ labels: [] }));
    await oldWork;
    expect(await queue(db)).toEqual(advanced);
    expect(advanced.cursor).toBe("page2");
    expect(await visible(db, config)).toBe(0);
  });

  it("checkpoints successful pages and backs off current failures", async () => {
    const { db, config } = await setup(["!hide"]);
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => { throw new Error("temporary failure"); })
      .mockImplementationOnce(async () => Response.json({ labels: [label], cursor: "page2" }))
      .mockImplementationOnce(async () => Response.json({ labels: [] }));
    await runLabelBackfillQueue(db, config);
    const failed = await queue(db);
    expect(failed.retries).toBe(1);
    expect(failed.next_attempt_at).toBeGreaterThan(Date.now());
    await db.prepare("UPDATE label_backfill_queue SET next_attempt_at = 0").run();
    await runLabelBackfillQueue(db, config);
    const page = await queue(db);
    expect(page.cursor).toBe("page2");
    expect(page.completed).toBe(0);
    expect(page.generation).toBe(failed.generation + 1);
    await runLabelBackfillQueue(db, config);
    expect((await queue(db)).completed).toBe(1);
    expect((await queue(db)).retries).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await visible(db, config)).toBe(0);
  });

  it("restarts a rejected cursor and recovers historical hide labels", async () => {
    const { db, config } = await setup(["!hide"]);
    await db.prepare("UPDATE label_backfill_queue SET cursor = 'expired'").run();
    const before = await queue(db);
    const cursors: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const cursor = new URL(String(input)).searchParams.get("cursor");
      cursors.push(cursor);
      return cursor === "expired"
        ? Response.json({ error: "InvalidCursor" }, { status: 400 })
        : Response.json({ labels: [label] });
    });
    await runLabelBackfillQueue(db, config);
    expect(await queue(db)).toMatchObject({
      cursor: null, completed: 0, retries: 1, generation: before.generation + 1,
    });
    expect((await queue(db)).next_attempt_at).toBeGreaterThan(Date.now());
    expect(await storedLabels(db)).toEqual([]);
    await db.prepare("UPDATE label_backfill_queue SET next_attempt_at = 0").run();
    await runLabelBackfillQueue(db, config);
    expect(cursors).toEqual(["expired", null]);
    expect(await queue(db)).toMatchObject({ cursor: null, completed: 1, retries: 0 });
    expect(await visible(db, config)).toBe(0);
  });

  it.each([
    [429, "RateLimitExceeded"],
    [500, "InternalServerError"],
    [500, "InvalidCursor"],
    [400, "InvalidRequest"],
    [400, null],
  ] as const)("retains a cursor for other HTTP failures (%s, %s)", async (status, error) => {
    const { db, config } = await setup(["!hide"]);
    await db.prepare("UPDATE label_backfill_queue SET cursor = 'page2'").run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => error
      ? Response.json({ error }, { status })
      : new Response("not JSON", { status }));
    await runLabelBackfillQueue(db, config);
    expect(await queue(db)).toMatchObject({ cursor: "page2", completed: 0, retries: 1 });
    expect((await queue(db)).next_attempt_at).toBeGreaterThan(Date.now());
  });

  it("does not reset a newer worker's checkpoint for a stale invalid cursor", async () => {
    const { db, config } = await setup(["!hide"]);
    await db.prepare("UPDATE label_backfill_queue SET cursor = 'expired'").run();
    const delayed = delayedFetch();
    const oldWork = runLabelBackfillQueue(db, config);
    await delayed.started;
    await runLabelBackfillQueue(db, config);
    const advanced = await queue(db);
    delayed.response.resolve(Response.json({ error: "InvalidCursor" }, { status: 400 }));
    await oldWork;
    expect(await queue(db)).toEqual(advanced);
  });

  it("adds a generation column to pre-existing queues on schema init", async () => {
    const db = createTestDb();
    await db.prepare(`CREATE TABLE label_backfill_queue (
      src TEXT NOT NULL, did TEXT NOT NULL, cursor TEXT, completed INTEGER NOT NULL DEFAULT 0,
      retries INTEGER NOT NULL DEFAULT 0, next_attempt_at BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (src, did)
    )`).run();
    await db.prepare("INSERT INTO label_backfill_queue (src, did, cursor, retries) VALUES (?, ?, ?, ?)")
      .bind(src, did, "saved-page", 3).run();
    await initSchema(db, TEST_CONFIG);
    expect(await queue(db)).toMatchObject({ cursor: "saved-page", retries: 3, generation: 0 });
  });
});
