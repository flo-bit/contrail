import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase } from "../src/adapters/pglite";
import { postgresDialect } from "../src/core/dialect";
import { initSchema, ingestRecords, queryRecords, resolveConfig, type Database } from "../src/index";
import { makeEvent } from "./helpers";

describe("PGlite adapter", () => {
  let pglite: PGlite;
  let db: Database;

  beforeAll(async () => {
    pglite = new PGlite();
    db = createPgliteDatabase(pglite);
    await pglite.waitReady;
  }, 60_000);

  afterAll(async () => {
    await pglite?.close();
  });

  beforeEach(async () => {
    await db.prepare("DROP TABLE IF EXISTS adapter_items").run();
    await db.prepare("CREATE TABLE adapter_items (id INTEGER PRIMARY KEY, value TEXT)").run();
  });

  it("uses the PostgreSQL dialect", () => {
    expect(db.dialect).toBe(postgresDialect);
  });

  it("binds values without mutating reusable statements or quoted question marks", async () => {
    const insert = db.prepare("INSERT INTO adapter_items VALUES (?, ?)");
    const first = insert.bind(1, "first");
    const second = insert.bind(2, "second");
    await first.run();
    await second.run();

    expect(await db.prepare("SELECT * FROM adapter_items ORDER BY id").all()).toEqual({
      results: [{ id: 1, value: "first" }, { id: 2, value: "second" }],
    });
    expect(await db.prepare("SELECT '?' AS literal, 'it''s ?' AS quoted, ?::text AS value")
      .bind("bound?").first()).toEqual({ literal: "?", quoted: "it's ?", value: "bound?" });
    expect(await db.prepare("SELECT * FROM adapter_items WHERE id = ?").bind(99).first()).toBeNull();
    expect(await db.prepare("SELECT * FROM adapter_items WHERE id = ?").bind(99).all()).toEqual({ results: [] });
  });

  it("reports affected rows for writes without RETURNING", async () => {
    expect(await db.prepare("INSERT INTO adapter_items VALUES (?, ?), (?, ?)")
      .bind(1, "a", 2, "b").run()).toEqual({ changes: 2 });
    expect(await db.prepare("UPDATE adapter_items SET value = ?").bind("updated").run())
      .toEqual({ changes: 2 });
    expect(await db.prepare("UPDATE adapter_items SET value = ? WHERE id = ?").bind("missing", 99).run())
      .toEqual({ changes: 0 });
    expect(await db.prepare("DELETE FROM adapter_items WHERE id = ?").bind(1).run())
      .toEqual({ changes: 1 });
    expect(await db.prepare("DELETE FROM adapter_items").run()).toEqual({ changes: 1 });
    expect(await db.prepare("DELETE FROM adapter_items").run()).toEqual({ changes: 0 });
  });

  it("normalizes JSON records and current BIGINT fields for first and all", async () => {
    const sql = `SELECT '{"name":"Test"}'::jsonb AS record,
      '123'::text AS time_us, '456'::text AS source_time_us,
      '789'::text AS head_position, '42'::text AS total,
      '1000'::text AS lease_expires_at, '2000'::text AS updated_at`;
    const expected = {
      record: '{"name":"Test"}', time_us: 123, source_time_us: 456,
      head_position: 789, total: 42, lease_expires_at: 1000, updated_at: 2000,
    };
    expect(await db.prepare(sql).first()).toEqual(expected);
    expect(await db.prepare(sql).all()).toEqual({ results: [expected] });
    expect(await db.prepare("SELECT NULL::jsonb AS record, NULL::bigint AS time_us").first())
      .toEqual({ record: null, time_us: null });
  });

  it("commits batches in order with affected-row counts", async () => {
    expect(await db.batch([
      db.prepare("INSERT INTO adapter_items VALUES (?, ?)").bind(1, "before"),
      db.prepare("UPDATE adapter_items SET value = ? WHERE id = ?").bind("after", 1),
      db.prepare("DELETE FROM adapter_items WHERE id = ?").bind(99),
    ])).toEqual([{ changes: 1 }, { changes: 1 }, { changes: 0 }]);
    expect(await db.prepare("SELECT * FROM adapter_items").first()).toEqual({ id: 1, value: "after" });
    expect(await db.batch([])).toEqual([]);
  });

  it("rolls back a failed batch and remains usable", async () => {
    await expect(db.batch([
      db.prepare("INSERT INTO adapter_items VALUES (?, ?)").bind(1, "rolled back"),
      db.prepare("INSERT INTO adapter_items VALUES (?, ?)").bind(1, "duplicate"),
    ])).rejects.toThrow(/duplicate key/);
    expect(await db.prepare("SELECT * FROM adapter_items").all()).toEqual({ results: [] });
    expect(await db.prepare("INSERT INTO adapter_items VALUES (?, ?)").bind(2, "survives").run())
      .toEqual({ changes: 1 });
  });

  it("keeps concurrent queries and batches outside a rolling-back transaction", async () => {
    // Pause after the transaction starts to deterministically queue both kinds
    // of concurrent operation while its connection is occupied.
    let started!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const proceed = new Promise<void>((resolve) => { resume = resolve; });
    const original = pglite.transaction.bind(pglite);
    const spy = vi.spyOn(pglite, "transaction").mockImplementationOnce((run) =>
      original(async (tx) => {
        started();
        await proceed;
        return run(tx);
      }));
    try {
      const failing = db.batch([
        db.prepare("INSERT INTO adapter_items VALUES (1, 'rolled back')"),
        db.prepare("INSERT INTO adapter_items VALUES (1, 'duplicate')"),
      ]);
      // Attach a rejection handler before letting the transaction fail.
      const rejected = expect(failing).rejects.toThrow(/duplicate key/);
      await entered;
      const outsideQuery = db.prepare("INSERT INTO adapter_items VALUES (2, 'query')").run();
      const outsideBatch = db.batch([db.prepare("INSERT INTO adapter_items VALUES (3, 'batch')")]);
      resume();
      await Promise.all([rejected, outsideQuery, outsideBatch]);
      expect(await db.prepare("SELECT * FROM adapter_items ORDER BY id").all()).toEqual({
        results: [{ id: 2, value: "query" }, { id: 3, value: "batch" }],
      });
    } finally {
      resume();
      spy.mockRestore();
    }
  });

  it("initializes Contrail, ingests records, and runs JSON filters and full-text search", async () => {
    const config = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          queryable: { mode: {} },
          searchable: ["name"],
        },
      },
    });
    await initSchema(db, config);
    await initSchema(db, config);
    await ingestRecords(db, [
      makeEvent({ uri: "at://did:plc:test/community.lexicon.calendar.event/1", rkey: "1",
        record: { name: "Rust Meetup", mode: "online" }, time_us: 2000 }),
      makeEvent({ uri: "at://did:plc:test/community.lexicon.calendar.event/2", rkey: "2",
        record: { name: "TypeScript Workshop", mode: "in-person" }, time_us: 1000 }),
    ], config);
    const filtered = await queryRecords(db, config, {
      collection: "community.lexicon.calendar.event", filters: { mode: "online" },
    });
    expect(filtered.records).toHaveLength(1);
    expect(JSON.parse(filtered.records[0].record!).name).toBe("Rust Meetup");
    const searched = await queryRecords(db, config, {
      collection: "community.lexicon.calendar.event", search: "TypeScript",
    });
    expect(searched.records).toHaveLength(1);
    expect(JSON.parse(searched.records[0].record!).name).toBe("TypeScript Workshop");
  });
});

it("persists a caller-owned PGlite database across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contrail-pglite-"));
  let pglite = new PGlite(directory);
  try {
    let db = createPgliteDatabase(pglite);
    await db.prepare("CREATE TABLE persisted (id INTEGER PRIMARY KEY)").run();
    await db.prepare("INSERT INTO persisted VALUES (?)").bind(42).run();
    await pglite.close();
    pglite = new PGlite(directory);
    db = createPgliteDatabase(pglite);
    expect(await db.prepare("SELECT * FROM persisted").first()).toEqual({ id: 42 });
  } finally {
    await pglite.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
