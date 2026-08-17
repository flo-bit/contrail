import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "../src/index";
import { resolveConfig } from "../src/index";
import { createTestDb, makeEvent } from "./helpers";
import { initSchema, verifyBootstrapCandidate } from "../src/index";
import { ingestRecords, queryRecords } from "../src/index";
import { rebuildDerivedProjections } from "../src/core/db/records";

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
    await ingestRecords(
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

  it("rebuilds deferred FTS rows after bulk canonical writes", async () => {
    await ingestRecords(
      db,
      [
        makeEvent({
          uri: `at://did:plc:deferred/${collection}/deferred`,
          did: "did:plc:deferred",
          collection,
          rkey: "deferred",
          record: {
            name: "DeferredNeedle",
            mode: "online",
            description: "bulk loaded",
          },
        }),
      ],
      SEARCH_CONFIG,
      { skipDerivedProjections: true }
    );

    expect(
      (await queryRecords(db, SEARCH_CONFIG, {
        collection,
        search: "DeferredNeedle",
      })).records
    ).toHaveLength(0);

    await rebuildDerivedProjections(db, SEARCH_CONFIG);

    expect(
      (await queryRecords(db, SEARCH_CONFIG, {
        collection,
        search: "DeferredNeedle",
      })).records
    ).toHaveLength(1);
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
    await ingestRecords(
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
    await ingestRecords(db, [
      makeEvent({ uri: "at://did:plc:a/community.lexicon.calendar.event/1", collection, rkey: "1", record: { name: "Old Name", mode: "online", description: "test" }, time_us: 1000 }),
    ], SEARCH_CONFIG);
    await ingestRecords(db, [
      makeEvent({ uri: "at://did:plc:a/community.lexicon.calendar.event/1", collection, rkey: "1", record: { name: "New Name", mode: "online", description: "test" }, operation: "update", time_us: 2000 }),
    ], SEARCH_CONFIG);
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "Old" })).records).toHaveLength(0);
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "New" })).records).toHaveLength(1);
  });

  it("removes from FTS on delete", async () => {
    await ingestRecords(db, [
      makeEvent({ uri: "at://did:plc:a/community.lexicon.calendar.event/1", collection, rkey: "1", record: { name: "Deletable", mode: "online", description: "test" }, time_us: 1000 }),
    ], SEARCH_CONFIG);
    await ingestRecords(db, [
      makeEvent({ uri: "at://did:plc:a/community.lexicon.calendar.event/1", collection, rkey: "1", operation: "delete", record: { name: "Deletable", mode: "online", description: "test" }, time_us: 2000 }),
    ], SEARCH_CONFIG);
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "Deletable" })).records).toHaveLength(0);
  });

  it("does not duplicate FTS rows when the same record is re-applied during backfill", async () => {
    // The ordinary mapping table owns URI uniqueness even when a caller bypasses
    // existing-record replay detection. Search can therefore never fan out one
    // canonical URI through duplicate virtual-table rows.
    const event = makeEvent({
      uri: "at://did:plc:a/community.lexicon.calendar.event/1",
      collection,
      rkey: "1",
      record: { name: "Backfilled Meetup", mode: "online", description: "test" },
      time_us: 1000,
    });
    await ingestRecords(db, [event], SEARCH_CONFIG, { skipReplayDetection: true });
    await ingestRecords(db, [event], SEARCH_CONFIG, { skipReplayDetection: true });

    const result = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Meetup" });
    expect(result.records).toHaveLength(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM fts_community_lexicon_calendar_event_rows WHERE uri = ?",
        )
        .bind(event.uri)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM fts_community_lexicon_calendar_event")
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("maps only searchable records and supports absent delete plus recreate", async () => {
    const uri = "at://did:plc:a/community.lexicon.calendar.event/lifecycle";
    await ingestRecords(db, [
      makeEvent({
        uri,
        collection,
        rkey: "lifecycle",
        operation: "delete",
        time_us: 500,
      }),
    ], SEARCH_CONFIG);
    await ingestRecords(db, [
      makeEvent({
        uri,
        collection,
        rkey: "lifecycle",
        record: { name: "   ", startsAt: "2026-01-01T00:00:00Z" },
        time_us: 1000,
      }),
    ], SEARCH_CONFIG);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM fts_community_lexicon_calendar_event_rows WHERE uri = ?",
        )
        .bind(uri)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    await ingestRecords(db, [
      makeEvent({
        uri,
        collection,
        rkey: "lifecycle",
        operation: "update",
        record: { name: "MappedOnce" },
        time_us: 2000,
      }),
    ], SEARCH_CONFIG);
    const firstMapping = await db
      .prepare(
        "SELECT id FROM fts_community_lexicon_calendar_event_rows WHERE uri = ?",
      )
      .bind(uri)
      .first<{ id: number }>();
    expect(firstMapping).toBeTruthy();

    await ingestRecords(db, [
      makeEvent({
        uri,
        collection,
        rkey: "lifecycle",
        operation: "delete",
        time_us: 3000,
      }),
    ], SEARCH_CONFIG);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM fts_community_lexicon_calendar_event_rows WHERE uri = ?",
        )
        .bind(uri)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    await ingestRecords(db, [
      makeEvent({
        uri,
        collection,
        rkey: "lifecycle",
        operation: "create",
        record: { name: "MappedAgain" },
        time_us: 4000,
      }),
    ], SEARCH_CONFIG);
    expect((await queryRecords(db, SEARCH_CONFIG, {
      collection,
      search: "MappedAgain",
    })).records).toHaveLength(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM fts_community_lexicon_calendar_event_rows WHERE uri = ?",
        )
        .bind(uri)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("normalizes tab, newline, and NBSP identically during writes and rebuilds", async () => {
    const prefix = "at://did:plc:a/community.lexicon.calendar.event/whitespace-";
    await ingestRecords(db, [
      makeEvent({
        uri: `${prefix}tab`,
        collection,
        rkey: "whitespace-tab",
        record: { name: "\t" },
        time_us: 1000,
      }),
      makeEvent({
        uri: `${prefix}newline`,
        collection,
        rkey: "whitespace-newline",
        record: { name: "\n" },
        time_us: 1100,
      }),
      makeEvent({
        uri: `${prefix}nbsp`,
        collection,
        rkey: "whitespace-nbsp",
        record: { name: "\u00a0" },
        time_us: 1200,
      }),
      makeEvent({
        uri: `${prefix}wrapped`,
        collection,
        rkey: "whitespace-wrapped",
        record: { name: "\t\n\u00a0WhitespaceNeedle\u00a0\n" },
        time_us: 1300,
      }),
    ], SEARCH_CONFIG);

    const projected = async () =>
      db
        .prepare(
          `SELECT mapped.uri, fts.content
           FROM fts_community_lexicon_calendar_event_rows mapped
           JOIN fts_community_lexicon_calendar_event fts ON fts.rowid = mapped.id
           WHERE mapped.uri LIKE ?
           ORDER BY mapped.uri`,
        )
        .bind(`${prefix}%`)
        .all<{ uri: string; content: string }>();

    expect(await projected()).toEqual({
      results: [{ uri: `${prefix}wrapped`, content: "WhitespaceNeedle" }],
    });
    await rebuildDerivedProjections(db, SEARCH_CONFIG);
    expect(await projected()).toEqual({
      results: [{ uri: `${prefix}wrapped`, content: "WhitespaceNeedle" }],
    });
    expect((await queryRecords(db, SEARCH_CONFIG, {
      collection,
      search: "WhitespaceNeedle",
    })).records).toHaveLength(1);
  });

  it("evicts the stale FTS row when an update clears all searchable fields", async () => {
    // The delete must run unconditionally. If an update leaves every searchable
    // field empty, buildFtsContent returns null and there is nothing to re-insert,
    // but the prior FTS row must still be removed so old terms stop matching.
    await ingestRecords(db, [
      makeEvent({ uri: "at://did:plc:a/community.lexicon.calendar.event/1", collection, rkey: "1", record: { name: "Searchable Title", mode: "online", description: "find me" }, time_us: 1000 }),
    ], SEARCH_CONFIG);
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "Searchable" })).records).toHaveLength(1);

    const uri = "at://did:plc:a/community.lexicon.calendar.event/1";
    await ingestRecords(db, [
      makeEvent({ uri, collection, rkey: "1", record: { startsAt: "2026-01-01T00:00:00Z" }, operation: "update", time_us: 2000 }),
    ], SEARCH_CONFIG);
    expect((await queryRecords(db, SEARCH_CONFIG, { collection, search: "Searchable" })).records).toHaveLength(0);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM fts_community_lexicon_calendar_event_rows WHERE uri = ?",
        )
        .bind(uri)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });
});

describe.skipIf(!hasFts)("FTS rowid schema migration", () => {
  it("rebuilds a duplicate legacy URI table from canonical records", async () => {
    const legacy = createTestDb();
    const recordsTable = "records_community_lexicon_calendar_event";
    const ftsTable = "fts_community_lexicon_calendar_event";
    const rowsTable = `${ftsTable}_rows`;
    const uri = "at://did:plc:legacy/community.lexicon.calendar.event/one";

    await legacy
      .prepare(
        `CREATE TABLE ${recordsTable} (
          uri TEXT PRIMARY KEY,
          did TEXT NOT NULL,
          rkey TEXT NOT NULL,
          cid TEXT,
          record TEXT,
          time_us INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL
        )`,
      )
      .run();
    await legacy
      .prepare(
        `INSERT INTO ${recordsTable}
         (uri, did, rkey, cid, record, time_us, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        uri,
        "did:plc:legacy",
        "one",
        "cid-legacy",
        JSON.stringify({ name: "MigrationNeedle" }),
        1,
        1,
      )
      .run();
    await legacy
      .prepare(
        `CREATE VIRTUAL TABLE ${ftsTable} USING fts5(uri UNINDEXED, content)`,
      )
      .run();
    await legacy
      .prepare(`INSERT INTO ${ftsTable} (uri, content) VALUES (?, ?), (?, ?)`)
      .bind(uri, "stale", uri, "duplicate")
      .run();

    await initSchema(legacy, SEARCH_CONFIG);

    const columns = await legacy
      .prepare(`PRAGMA table_info(${ftsTable})`)
      .all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual(["content"]);
    expect(
      await legacy
        .prepare(`SELECT uri FROM ${rowsTable}`)
        .all<{ uri: string }>(),
    ).toEqual({ results: [{ uri }] });
    expect(
      await legacy
        .prepare(`SELECT COUNT(*) AS count FROM ${ftsTable}`)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect((await queryRecords(legacy, SEARCH_CONFIG, {
      collection: "community.lexicon.calendar.event",
      search: "MigrationNeedle",
    })).records).toHaveLength(1);
    const verification = await verifyBootstrapCandidate(legacy, SEARCH_CONFIG);
    const ftsChecks = verification.checks.filter(
      ({ name }) =>
        name.includes("fts-") &&
        name.endsWith("community.lexicon.calendar.event"),
    );
    expect(ftsChecks).toHaveLength(4);
    expect(ftsChecks.every(({ ok }) => ok)).toBe(true);

    const plan = await legacy
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM ${ftsTable}
         WHERE rowid = (SELECT id FROM ${rowsTable} WHERE uri = ?)`,
      )
      .bind(uri)
      .all<{ detail: string }>();
    expect(plan.results.some(({ detail }) =>
      detail.includes(rowsTable) && detail.includes("uri=?")
    )).toBe(true);
    expect(plan.results.some(({ detail }) =>
      detail === `SCAN ${ftsTable} VIRTUAL TABLE INDEX 0:`
    )).toBe(false);
    expect(plan.results.some(({ detail }) =>
      detail === `SCAN ${ftsTable} VIRTUAL TABLE INDEX 0:=`
    )).toBe(true);

    await initSchema(legacy, SEARCH_CONFIG);
    expect(
      await legacy
        .prepare(`SELECT COUNT(*) AS count FROM ${ftsTable}`)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("does not accept a stale content-only schema until rebuilding verifies", async () => {
    const stale = createTestDb();
    const migrationConfig = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          searchable: ["name"],
        },
      },
    });
    const uri = "at://did:plc:legacy/community.lexicon.calendar.event/retry";
    await stale
      .prepare("CREATE TABLE _contrail_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
      .run();
    await stale
      .prepare("INSERT INTO _contrail_meta (key, value) VALUES ('schema_fingerprint', 'stale')")
      .run();
    await stale
      .prepare(
        `CREATE TABLE records_event (
          uri TEXT PRIMARY KEY,
          did TEXT NOT NULL,
          rkey TEXT NOT NULL,
          cid TEXT,
          record TEXT,
          time_us INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL
        )`,
      )
      .run();
    await stale
      .prepare(
        `INSERT INTO records_event
         (uri, did, rkey, cid, record, time_us, indexed_at)
         VALUES (?, 'did:plc:legacy', 'retry', 'cid-retry', 'not-json', 1, 1)`,
      )
      .bind(uri)
      .run();
    await stale
      .prepare(
        "CREATE TABLE fts_event_rows (id INTEGER PRIMARY KEY, uri TEXT NOT NULL UNIQUE)",
      )
      .run();
    await stale
      .prepare("INSERT INTO fts_event_rows (uri) VALUES ('at://stale')")
      .run();
    await stale
      .prepare("CREATE VIRTUAL TABLE fts_event USING fts5(content)")
      .run();
    await stale
      .prepare("INSERT INTO fts_event (rowid, content) VALUES (1, 'stale')")
      .run();

    await expect(initSchema(stale, migrationConfig)).rejects.toThrow();
    expect(
      await stale
        .prepare("SELECT value FROM _contrail_meta WHERE key = 'schema_fingerprint'")
        .first<{ value: string }>(),
    ).toEqual({ value: "stale" });
    expect(
      await stale.prepare("SELECT uri FROM fts_event_rows").all<{ uri: string }>(),
    ).toEqual({ results: [{ uri: "at://stale" }] });

    await stale
      .prepare("UPDATE records_event SET record = ? WHERE uri = ?")
      .bind(JSON.stringify({ name: "RecoveryNeedle" }), uri)
      .run();
    await initSchema(stale, migrationConfig);

    expect(
      await stale.prepare("SELECT uri FROM fts_event_rows").all<{ uri: string }>(),
    ).toEqual({ results: [{ uri }] });
    expect(
      await stale.prepare("SELECT content FROM fts_event").all<{ content: string }>(),
    ).toEqual({ results: [{ content: "RecoveryNeedle" }] });
    expect(
      await stale
        .prepare("SELECT value FROM _contrail_meta WHERE key = 'schema_fingerprint'")
        .first<{ value: string }>(),
    ).not.toEqual({ value: "stale" });
  });

  it("rolls the legacy table back when canonical rebuilding fails", async () => {
    const legacy = createTestDb();
    const migrationConfig = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          searchable: ["name"],
        },
      },
    });
    await legacy
      .prepare(
        `CREATE TABLE records_event (
          uri TEXT PRIMARY KEY,
          did TEXT NOT NULL,
          rkey TEXT NOT NULL,
          cid TEXT,
          record TEXT,
          time_us INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL
        )`,
      )
      .run();
    await legacy
      .prepare(
        `INSERT INTO records_event
         (uri, did, rkey, cid, record, time_us, indexed_at)
         VALUES ('at://did:plc:legacy/community.lexicon.calendar.event/bad',
                 'did:plc:legacy', 'bad', 'cid-bad', 'not-json', 1, 1)`,
      )
      .run();
    await legacy
      .prepare(
        "CREATE VIRTUAL TABLE fts_event USING fts5(uri UNINDEXED, content)",
      )
      .run();
    await legacy
      .prepare(
        "INSERT INTO fts_event (uri, content) VALUES ('at://legacy', 'keep-old')",
      )
      .run();

    await expect(initSchema(legacy, migrationConfig)).rejects.toThrow();

    const columns = await legacy
      .prepare("PRAGMA table_info(fts_event)")
      .all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual(["uri", "content"]);
    expect(
      await legacy
        .prepare("SELECT uri, content FROM fts_event")
        .all<{ uri: string; content: string }>(),
    ).toEqual({ results: [{ uri: "at://legacy", content: "keep-old" }] });
    expect(
      await legacy
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'fts_event_rows'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });
});

describe.skipIf(!hasFts)("explicit searchable fields", () => {
  const collection = "test.explicit.collection";

  beforeEach(async () => {
    await ingestRecords(db, [
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
    await ingestRecords(db, [
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
    await ingestRecords(db, events, SEARCH_CONFIG);
  });

  it("paginates search results", async () => {
    const page1 = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Rust", limit: 3 });
    expect(page1.records).toHaveLength(3);
    expect(page1.cursor).toBeDefined();
    const page2 = await queryRecords(db, SEARCH_CONFIG, { collection, search: "Rust", limit: 3, cursor: page1.cursor });
    expect(page2.records).toHaveLength(2);
    expect(page2.cursor).toBeUndefined();
  });

  it("uses rank, time, and URI together when paginating", async () => {
    await ingestRecords(
      db,
      [
        makeEvent({
          uri: `at://did:plc:a/${collection}/rank-a`,
          collection,
          rkey: "rank-a",
          record: { name: "Quokka", mode: "", description: "" },
          time_us: 1000,
        }),
        makeEvent({
          uri: `at://did:plc:a/${collection}/rank-b`,
          collection,
          rkey: "rank-b",
          record: {
            name: "Quokka community gathering with a deliberately long title",
            mode: "online",
            description: "many unrelated words make this a weaker match",
          },
          time_us: 3000,
        }),
        makeEvent({
          uri: `at://did:plc:a/${collection}/rank-c`,
          collection,
          rkey: "rank-c",
          record: {
            name: "Quokka event with another deliberately long title",
            mode: "online",
            description: "more unrelated words make this weaker too",
          },
          time_us: 2000,
        }),
      ],
      SEARCH_CONFIG,
    );

    const complete = await queryRecords(db, SEARCH_CONFIG, {
      collection,
      search: "Quokka",
      limit: 50,
    });
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await queryRecords(db, SEARCH_CONFIG, {
        collection,
        search: "Quokka",
        limit: 1,
        cursor,
      });
      paged.push(...page.records.map((record) => record.uri));
      cursor = page.cursor;
    } while (cursor && paged.length < 10);

    expect(paged).toEqual(complete.records.map((record) => record.uri));
    expect(paged).toHaveLength(3);
  });
});
