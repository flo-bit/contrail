import { describe, it, expect } from "vitest";
import { initSchema } from "../src/index";
import { createTestDb, TEST_CONFIG } from "./helpers";

describe("initSchema", () => {
  it("creates all required tables", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);

    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all<{ name: string }>();
    const names = tables.results.map((t) => t.name);

    expect(names).toContain("records_event");
    expect(names).toContain("records_rsvp");
    expect(names).toContain("backfills");
    expect(names).toContain("backfill_state");
    expect(names).toContain("discovery");
    expect(names).toContain("cursor");
    expect(names).toContain("identities");

    const backfillColumns = await db
      .prepare("PRAGMA table_info(backfills)")
      .all<{ name: string }>();
    expect(backfillColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "last_attempt_at",
        "next_retry_at",
        "scheduled_retries",
        "retry_exhausted",
      ])
    );

    const discoveryColumns = await db
      .prepare("PRAGMA table_info(discovery)")
      .all<{ name: string }>();
    expect(discoveryColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "retries",
        "last_error",
        "last_attempt_at",
        "next_retry_at",
      ])
    );
  });

  it("creates dynamic indexes for queryable fields", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);

    const indexes = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all<{ name: string }>();
    const names = indexes.results.map((i) => i.name);

    // Should have indexes for queryable fields
    expect(names.some((n) => n.includes("mode"))).toBe(true);
    expect(names.some((n) => n.includes("name"))).toBe(true);
    expect(names.some((n) => n.includes("startsAt"))).toBe(true);
  });

  it("creates relation indexes", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);

    const indexes = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all<{ name: string }>();
    const names = indexes.results.map((i) => i.name);

    // Should have index for subject.uri relation field
    expect(names.some((n) => n.includes("subject"))).toBe(true);
  });

  it("migrates existing backfill and discovery state tables", async () => {
    const db = createTestDb();
    await db
      .prepare(
        "CREATE TABLE backfills (did TEXT NOT NULL, collection TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, pds_cursor TEXT, retries INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY (did, collection))"
      )
      .run();
    await db
      .prepare(
        "CREATE TABLE discovery (collection TEXT NOT NULL, relay TEXT NOT NULL, cursor TEXT, completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (collection, relay))"
      )
      .run();

    await initSchema(db, TEST_CONFIG);

    const backfillColumns = await db
      .prepare("PRAGMA table_info(backfills)")
      .all<{ name: string }>();
    expect(backfillColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "last_attempt_at",
        "next_retry_at",
        "scheduled_retries",
        "retry_exhausted",
      ])
    );

    const discoveryColumns = await db
      .prepare("PRAGMA table_info(discovery)")
      .all<{ name: string }>();
    expect(discoveryColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "retries",
        "last_error",
        "last_attempt_at",
        "next_retry_at",
      ])
    );
  });

  it("is idempotent", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);
    // Running again should not throw
    await initSchema(db, TEST_CONFIG);
  });
});

