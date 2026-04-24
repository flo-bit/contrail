import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "../src/core/types";
import { resolveConfig } from "../src/core/types";
import { createTestDb, makeEvent } from "./helpers";
import { initSchema } from "../src/core/db/schema";
import { applyEvents, queryRecords } from "../src/core/db/records";

// Detect FTS5 support at module level (node:sqlite doesn't include it)
let hasFts = false;
try {
  const testDb = createTestDb();
  await testDb.prepare("CREATE VIRTUAL TABLE __fts_test USING fts5(content)").run();
  hasFts = true;
} catch {}

const SEARCH_CONFIG = resolveConfig({
  namespace: "com.example",
  collections: {
    "community.lexicon.calendar.event": {
      queryable: {
        mode: {},
        name: {},
        description: {},
        startsAt: { type: "range" },
      },
      searchable: ["mode", "name", "description"],
    },
    "test.explicit.collection": {
      queryable: {
        title: {},
        body: {},
        category: {},
      },
      searchable: ["title", "body"],
    },
    "test.disabled.collection": {
      queryable: {
        name: {},
      },
      searchable: false,
    },
  },
});

let db: Database;

beforeEach(async () => {
  if (!hasFts) return;
  db = createTestDb();
  await initSchema(db, SEARCH_CONFIG);
});

describe.skipIf(!hasFts)("FTS with explicit searchable fields", () => {
  const collection = "community.lexicon.calendar.event";

  beforeEach(async () => {
    await applyEvents(
      db,
      [
        makeEvent({
          uri: "at://did:plc:a/community.lexicon.calendar.event/1",
          did: "did:plc:a",
          collection,
          rkey: "1",
          record: { name: "Rust Meetup", mode: "in-person", description: "A gathering of Rustaceans" },
          time_us: 3000,
        }),
        makeEvent({
          uri: "at://did:plc:b/community.lexicon.calendar.event/2",
          did: "did:plc:b",
          collection,
          rkey: "2",
          record: { name: "TypeScript Workshop", mode: "online", description: "Learn advanced TypeScript" },
          time_us: 2000,
        }),
        makeEvent({
          uri: "at://did:plc:c/community.lexicon.calendar.event/3",
          did: "did:plc:c",
          collection,
          rkey: "3",
          record: { name: "Rust and TypeScript", mode: "hybrid", description: "Best of both worlds" },
          time_us: 1000,
        }),
      ],
      SEARCH_CONFIG
    );
  });

  it("finds records matching a search term", async () => {
    const result = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Rust" });
    expect(result.records).toHaveLength(2);
    const names = result.records.map((r) => JSON.parse(r.record!).name);
    expect(names).toContain("Rust Meetup");
    expect(names).toContain("Rust and TypeScript");
  });

  it("searches across multiple fields", async () => {
    const result = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Rustaceans" });
    expect(result.records).toHaveLength(1);
    expect(JSON.parse(result.records[0].record!).name).toBe("Rust Meetup");
  });

  it("returns nothing for non-matching search", async () => {
    const result = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Python" });
    expect(result.records).toHaveLength(0);
  });

  it("supports prefix search", async () => {
    const result = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Type*" });
    expect(result.records).toHaveLength(2);
  });

  it("combines search with filters", async () => {
    const result = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Rust", filters: { mode: "in-person" } });
    expect(result.records).toHaveLength(1);
    expect(JSON.parse(result.records[0].record!).name).toBe("Rust Meetup");
  });

  it("does not search range fields (startsAt)", async () => {
    await applyEvents(
      db,
      [
        makeEvent({
          uri: "at://did:plc:d/community.lexicon.calendar.event/4",
          did: "did:plc:d",
          collection,
          rkey: "4",
          record: { name: "Date Event", startsAt: "2026-04-01T10:00:00Z", mode: "online", description: "Nothing special" },
          time_us: 500,
        }),
      ],
      SEARCH_CONFIG
    );
    const result = await queryRecords(db, SEARCH_CONFIG, { collection, search: "T10" });
    expect(result.records).toHaveLength(0);
  });
});

describe.skipIf(!hasFts)("FTS sync", () => {
  const collection = "community.lexicon.calendar.event";

  it("updates FTS on record update", async () => {
    await applyEvents(db, [
      makeEvent({ uri: "at://did:plc:a/community.lexicon.calendar.event/1", collection, rkey: "1", record: { name: "Old Name", mode: "online", description: "test" }, time_us: 1000 }),
    ], SEARCH_CONFIG);
    await applyEvents(db, [
      makeEvent({ uri: "at://did:plc:a/community.lexicon.calendar.event/1", collection, rkey: "1", record: { name: "New Name", mode: "online", description: "test" }, operation: "update", time_us: 2000 }),
    ], SEARCH_CONFIG);
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "Old" })).records).toHaveLength(0);
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "New" })).records).toHaveLength(1);
  });

  it("removes from FTS on delete", async () => {
    await applyEvents(db, [
      makeEvent({ uri: "at://did:plc:a/community.lexicon.calendar.event/1", collection, rkey: "1", record: { name: "Deletable", mode: "online", description: "test" }, time_us: 1000 }),
    ], SEARCH_CONFIG);
    await applyEvents(db, [
      makeEvent({ uri: "at://did:plc:a/community.lexicon.calendar.event/1", collection, rkey: "1", operation: "delete", record: { name: "Deletable", mode: "online", description: "test" }, time_us: 2000 }),
    ], SEARCH_CONFIG);
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "Deletable" })).records).toHaveLength(0);
  });
});

describe.skipIf(!hasFts)("explicit searchable fields", () => {
  const collection = "test.explicit.collection";

  beforeEach(async () => {
    await applyEvents(db, [
      makeEvent({ uri: "at://did:plc:a/test.explicit.collection/1", did: "did:plc:a", collection, rkey: "1", record: { title: "Interesting Article", body: "Some content here", category: "tech" }, time_us: 1000 }),
    ], SEARCH_CONFIG);
  });

  it("searches in explicitly listed fields", async () => {
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "Interesting" })).records).toHaveLength(1);
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "content" })).records).toHaveLength(1);
  });

  it("does not search non-listed fields", async () => {
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "tech" })).records).toHaveLength(0);
  });
});

describe.skipIf(!hasFts)("searchable: false", () => {
  const collection = "test.disabled.collection";

  it("search param is ignored when FTS is disabled", async () => {
    await applyEvents(db, [
      makeEvent({ uri: "at://did:plc:a/test.disabled.collection/1", did: "did:plc:a", collection, rkey: "1", record: { name: "Should Not Be Searchable" }, time_us: 1000 }),
    ], SEARCH_CONFIG);
    const result = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Searchable" });
    expect(result.records).toHaveLength(1);
  });
});

describe.skipIf(!hasFts)("search pagination", () => {
  const collection = "community.lexicon.calendar.event";

  beforeEach(async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        uri: `at://did:plc:a/community.lexicon.calendar.event/e${i}`,
        did: "did:plc:a",
        collection,
        rkey: `e${i}`,
        record: { name: `Rust Event ${i}`, mode: "online", description: "test" },
        time_us: (i + 1) * 1000,
      })
    );
    await applyEvents(db, events, SEARCH_CONFIG);
  });

  it("paginates search results", async () => {
    const page1 = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Rust", limit: 3 });
    expect(page1.records).toHaveLength(3);
    expect(page1.cursor).toBeDefined();
    const page2 = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Rust", limit: 3, cursor: page1.cursor });
    expect(page2.records).toHaveLength(2);
    expect(page2.cursor).toBeUndefined();
  });
});
