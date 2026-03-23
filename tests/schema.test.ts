import { describe, it, expect } from "vitest";
import { initSchema } from "../src/core/db/schema";
import { createTestDb, TEST_CONFIG } from "./helpers";

describe("initSchema", () => {
  it("creates all required tables", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);

    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all<{ name: string }>();
    const names = tables.results.map((t) => t.name);

    expect(names).toContain("records_community_lexicon_calendar_event");
    expect(names).toContain("records_community_lexicon_calendar_rsvp");
    expect(names).toContain("backfills");
    expect(names).toContain("discovery");
    expect(names).toContain("cursor");
    expect(names).toContain("identities");
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

  it("is idempotent", async () => {
    const db = createTestDb();
    await initSchema(db, TEST_CONFIG);
    // Running again should not throw
    await initSchema(db, TEST_CONFIG);
  });
});
