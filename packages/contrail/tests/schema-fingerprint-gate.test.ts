import { describe, it, expect } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import {
  initSchema,
  ingestRecords,
  queryRecords,
  saveCursor,
  getLastCursor,
} from "../src/index";
import { getMeta, setMeta } from "../src/core/db/meta";
import { FTS_FINGERPRINTS_KEY, LEGACY_MIGRATIONS_KEY } from "../src/core/db/schema";
import { resolveConfig } from "../src/index";
import type { Database, Statement } from "../src/index";
import { makeEvent } from "./helpers";

// initSchema replays ~40 DDL statements serially on every call; on recycled
// Workers isolates that's hundreds of ms of cold-start round-trips. The
// fingerprint gate must skip all of it after a single read when the schema is
// unchanged, and re-apply when it changes.

function recordingDb(real: Database): { db: Database; prepares: string[] } {
  const prepares: string[] = [];
  const db: Database = {
    prepare(sql: string): Statement {
      prepares.push(sql);
      return real.prepare(sql);
    },
    batch(stmts: Statement[]): Promise<any[]> {
      return real.batch(stmts);
    },
    dialect: real.dialect,
  };
  return { db, prepares };
}

const CONFIG = resolveConfig({
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: { name: {} },
    },
  },
});

describe("schema fingerprint gate", () => {
  it("applies the full DDL on first init, then skips a matching second init", async () => {
    const real = createSqliteDatabase(":memory:");

    const first = recordingDb(real);
    await initSchema(first.db, CONFIG);
    expect(first.prepares.length).toBeGreaterThan(10); // full apply

    const fp = await getMeta(real, "schema_fingerprint");
    expect(fp).toBeTruthy();

    const second = recordingDb(real);
    await initSchema(second.db, CONFIG);
    // Steady state: a single read, zero DDL.
    expect(second.prepares).toHaveLength(1);
    expect(second.prepares[0]).toMatch(/_contrail_meta/);
    expect(await getMeta(real, "schema_fingerprint")).toBe(fp); // unchanged
  });

  it("adds the pending-backfill index to a current database without rebuilding it", async () => {
    const real = createSqliteDatabase(":memory:");
    await initSchema(real, CONFIG);
    const current = (await getMeta(real, "schema_fingerprint"))!;
    const previous = current.replace(/:backfills-pending-v1$/, "");
    expect(previous).not.toBe(current);
    await real.prepare("DROP INDEX idx_backfills_pending").run();
    await setMeta(real, "schema_fingerprint", previous);

    const upgraded = recordingDb(real);
    await initSchema(upgraded.db, CONFIG);

    expect(
      await real
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_backfills_pending'")
        .first(),
    ).toBeTruthy();
    expect(upgraded.prepares.some((sql) => /fts_event|records_event/.test(sql))).toBe(false);
    expect(await getMeta(real, "schema_fingerprint")).toBe(current);
  });

  it("re-applies when the generated schema changes (fingerprint busts)", async () => {
    const real = createSqliteDatabase(":memory:");
    await initSchema(real, CONFIG);
    const fp1 = await getMeta(real, "schema_fingerprint");

    // Add a collection → different generated DDL → different fingerprint.
    const CONFIG2 = resolveConfig({
      namespace: "com.example",
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          queryable: { name: {} },
        },
        note: { collection: "com.example.note" },
      },
    });

    const second = recordingDb(real);
    await initSchema(second.db, CONFIG2);
    expect(second.prepares.length).toBeGreaterThan(1); // DDL ran again
    expect(await getMeta(real, "schema_fingerprint")).not.toBe(fp1);

    // The new collection's table now exists.
    const row = await real
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='records_note'"
      )
      .first();
    expect(row).toBeTruthy();
  });

  it("does not skip on a fresh database (no fingerprint row yet)", async () => {
    const real = createSqliteDatabase(":memory:");
    const rec = recordingDb(real);
    // First-ever init: the gate read hits a missing _contrail_meta, resolves
    // null, and the full apply runs.
    await initSchema(rec.db, CONFIG);
    expect(rec.prepares.length).toBeGreaterThan(10);
    expect(await getMeta(real, "schema_fingerprint")).toBeTruthy();
    expect(await getMeta(real, LEGACY_MIGRATIONS_KEY)).toBeTruthy();
    expect(await getMeta(real, FTS_FINGERPRINTS_KEY)).toBe("{}");
  });

  it("does not rebuild FTS or re-run legacy migrations when dropping feeds on a populated DB", async () => {
    const real = createSqliteDatabase(":memory:");
    const withFeeds = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          queryable: { mode: {} },
          searchable: ["name"],
        },
        rsvp: {
          collection: "community.lexicon.calendar.rsvp",
          queryable: { status: {} },
        },
      },
      feeds: {
        following: { targets: ["event"], maxItems: 50 },
      },
    });
    await initSchema(real, withFeeds);

    await ingestRecords(
      real,
      [
        makeEvent({
          uri: "at://did:plc:alice/community.lexicon.calendar.event/e1",
          did: "did:plc:alice",
          collection: "community.lexicon.calendar.event",
          rkey: "e1",
          record: { name: "Berlin Meetup", mode: "in-person" },
          time_us: 10_000,
        }),
        makeEvent({
          uri: "at://did:plc:bob/community.lexicon.calendar.rsvp/r1",
          did: "did:plc:bob",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: { status: "going" },
          time_us: 11_000,
        }),
      ],
      withFeeds,
    );
    await saveCursor(real, 42_000);

    // Drop `feeds` completely without touching `event.searchable`.
    const withoutFeeds = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          queryable: { mode: {} },
          searchable: ["name"],
        },
        rsvp: {
          collection: "community.lexicon.calendar.rsvp",
          queryable: { status: {} },
        },
      },
    });

    const upgraded = recordingDb(real);
    await initSchema(upgraded.db, withoutFeeds);

    const sqlLog = upgraded.prepares.join("\n");
    expect(sqlLog).not.toMatch(/DELETE FROM fts_|INSERT INTO fts_/i);
    expect(sqlLog).not.toMatch(/UPDATE record_versions|INSERT INTO record_versions/i);
    expect(sqlLog).not.toMatch(/UPDATE labels SET cts/i);

    // Records, search, and cursor remain intact.
    expect(await getLastCursor(real)).toBe(42_000);
    const found = await queryRecords(real, withoutFeeds, {
      collection: "event",
      search: "Berlin",
    });
    expect(found.records).toHaveLength(1);
    expect(found.records[0]!.uri).toBe(
      "at://did:plc:alice/community.lexicon.calendar.event/e1",
    );

    // Next cold start returns to the 1-query steady state.
    const steady = recordingDb(real);
    await initSchema(steady.db, withoutFeeds);
    expect(steady.prepares).toHaveLength(1);
  });

  it("rebuilds FTS only for the collection whose searchable fields changed", async () => {
    const real = createSqliteDatabase(":memory:");
    const initial = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          searchable: ["name"],
        },
        note: {
          collection: "com.example.note",
          searchable: ["title"],
        },
      },
    });
    await initSchema(real, initial);
    await ingestRecords(
      real,
      [
        makeEvent({
          uri: "at://did:plc:alice/community.lexicon.calendar.event/e1",
          did: "did:plc:alice",
          collection: "community.lexicon.calendar.event",
          rkey: "e1",
          record: { name: "Conf", description: "GraphQL deep dive" },
          time_us: 1000,
        }),
        makeEvent({
          uri: "at://did:plc:alice/com.example.note/n1",
          did: "did:plc:alice",
          collection: "com.example.note",
          rkey: "n1",
          record: { title: "UnchangedNote" },
          time_us: 1100,
        }),
      ],
      initial,
    );

    const updated = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          searchable: ["name", "description"],
        },
        note: {
          collection: "com.example.note",
          searchable: ["title"],
        },
      },
    });

    const recorded = recordingDb(real);
    await initSchema(recorded.db, updated);

    const sqlLog = recorded.prepares.join("\n");
    expect(sqlLog).toMatch(/DELETE FROM fts_event/i);
    expect(sqlLog).not.toMatch(/DELETE FROM fts_note|INSERT INTO fts_note/i);
    expect(sqlLog).not.toMatch(/UPDATE record_versions|INSERT INTO record_versions/i);

    expect(
      (await queryRecords(real, updated, { collection: "event", search: "GraphQL" })).records,
    ).toHaveLength(1);
    expect(
      (await queryRecords(real, updated, { collection: "note", search: "UnchangedNote" })).records,
    ).toHaveLength(1);
  });

  it("propagates real database errors during virtual FTS table creation instead of swallowing them", async () => {
    const real = createSqliteDatabase(":memory:");
    const searchConfig = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          searchable: ["name"],
        },
      },
    });
    const failingDb: Database = {
      dialect: real.dialect,
      batch: (stmts) => real.batch(stmts),
      prepare(sql) {
        if (/CREATE VIRTUAL TABLE.*USING fts5/i.test(sql)) {
          return {
            bind() {
              return this;
            },
            async all() {
              throw new Error("D1_ERROR: exceeded CPU time limit");
            },
            async first() {
              throw new Error("D1_ERROR: exceeded CPU time limit");
            },
            async run() {
              throw new Error("D1_ERROR: exceeded CPU time limit");
            },
          };
        }
        return real.prepare(sql);
      },
    };

    await expect(initSchema(failingDb, searchConfig)).rejects.toThrow(
      /D1_ERROR: exceeded CPU time limit/,
    );
  });

  it("stamps FTS and legacy markers during fast upgrade paths so a follow-up feed removal skips rebuilds", async () => {
    const real = createSqliteDatabase(":memory:");
    const withFeeds = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          searchable: ["name"],
        },
      },
      feeds: {
        following: { targets: ["event"], maxItems: 50 },
      },
    });
    await initSchema(real, withFeeds);
    await ingestRecords(
      real,
      [
        makeEvent({
          uri: "at://did:plc:alice/community.lexicon.calendar.event/e1",
          did: "did:plc:alice",
          collection: "community.lexicon.calendar.event",
          rkey: "e1",
          record: { name: "FastPathEvent" },
          time_us: 1000,
        }),
      ],
      withFeeds,
    );

    // Simulate a pre-marker DB on the prior fast-path fingerprint (e.g. 0.31/0.32).
    const current = (await getMeta(real, "schema_fingerprint"))!;
    const previous = current.replace(/:backfills-pending-v1$/, "");
    await setMeta(real, "schema_fingerprint", previous);
    await real
      .prepare("DELETE FROM _contrail_meta WHERE key IN (?, ?)")
      .bind(FTS_FINGERPRINTS_KEY, LEGACY_MIGRATIONS_KEY)
      .run();

    // Step 1: upgrade via fast path — must stamp FTS and legacy markers without rebuild.
    const fastUpgrade = recordingDb(real);
    await initSchema(fastUpgrade.db, withFeeds);
    expect(fastUpgrade.prepares.join("\n")).not.toMatch(/DELETE FROM fts_|INSERT INTO fts_/i);
    expect(await getMeta(real, FTS_FINGERPRINTS_KEY)).toBeTruthy();
    expect(await getMeta(real, LEGACY_MIGRATIONS_KEY)).toBeTruthy();

    // Step 2: drop feeds — must still skip FTS rebuild and legacy version seeding.
    const withoutFeeds = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          searchable: ["name"],
        },
      },
    });
    const dropFeeds = recordingDb(real);
    await initSchema(dropFeeds.db, withoutFeeds);
    const dropSql = dropFeeds.prepares.join("\n");
    expect(dropSql).not.toMatch(/DELETE FROM fts_|INSERT INTO fts_/i);
    expect(dropSql).not.toMatch(/UPDATE record_versions|INSERT INTO record_versions/i);
    expect(
      (await queryRecords(real, withoutFeeds, { collection: "event", search: "FastPathEvent" }))
        .records,
    ).toHaveLength(1);
  });

  it("stamps decoupled markers on the steady path for pre-existing marker-less databases", async () => {
    const real = createSqliteDatabase(":memory:");
    const withFeeds = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          searchable: ["name"],
        },
      },
      feeds: {
        following: { targets: ["event"], maxItems: 50 },
      },
    });
    await initSchema(real, withFeeds);
    await ingestRecords(
      real,
      [
        makeEvent({
          uri: "at://did:plc:alice/community.lexicon.calendar.event/e1",
          did: "did:plc:alice",
          collection: "community.lexicon.calendar.event",
          rkey: "e1",
          record: { name: "PreExistingEvent" },
          time_us: 1000,
        }),
      ],
      withFeeds,
    );

    // Simulate a database created by 0.32.1 (current schema_fingerprint, no markers yet).
    await real
      .prepare("DELETE FROM _contrail_meta WHERE key IN (?, ?)")
      .bind(FTS_FINGERPRINTS_KEY, LEGACY_MIGRATIONS_KEY)
      .run();

    // First init on the steady path stamps both markers once without rebuilding.
    const firstSteady = recordingDb(real);
    await initSchema(firstSteady.db, withFeeds);
    expect(firstSteady.prepares.join("\n")).not.toMatch(/DELETE FROM fts_|INSERT INTO fts_|UPDATE record_versions/i);
    expect(await getMeta(real, FTS_FINGERPRINTS_KEY)).toBeTruthy();
    expect(await getMeta(real, LEGACY_MIGRATIONS_KEY)).toBeTruthy();

    // Subsequent steady-state init is back to a single read.
    const secondSteady = recordingDb(real);
    await initSchema(secondSteady.db, withFeeds);
    expect(secondSteady.prepares).toHaveLength(1);

    // Dropping feeds now skips both FTS rebuild and legacy record_versions seeding.
    const withoutFeeds = resolveConfig({
      namespace: "com.example",
      profiles: [],
      collections: {
        event: {
          collection: "community.lexicon.calendar.event",
          searchable: ["name"],
        },
      },
    });
    const dropped = recordingDb(real);
    await initSchema(dropped.db, withoutFeeds);
    const dropSql = dropped.prepares.join("\n");
    expect(dropSql).not.toMatch(/DELETE FROM fts_|INSERT INTO fts_/i);
    expect(dropSql).not.toMatch(/UPDATE record_versions|INSERT INTO record_versions/i);
    expect(
      (await queryRecords(real, withoutFeeds, { collection: "event", search: "PreExistingEvent" }))
        .records,
    ).toHaveLength(1);
  });

  it("upgrades a pre-marker v17 database (0.28–0.32) without rebuilding FTS or reseeding record_versions", async () => {
    const real = createSqliteDatabase(":memory:");
    const searchConfig = resolveConfig({
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
    await initSchema(real, searchConfig);
    await ingestRecords(
      real,
      [
        makeEvent({
          uri: "at://did:plc:alice/community.lexicon.calendar.event/e1",
          did: "did:plc:alice",
          collection: "community.lexicon.calendar.event",
          rkey: "e1",
          record: { name: "LegacyUpgradeEvent", mode: "in-person" },
          time_us: 1000,
        }),
      ],
      searchConfig,
    );
    await saveCursor(real, 77_000);

    // Simulate a database created by 0.28–0.31: prior schema_fingerprint,
    // moderation_cts_unit='milliseconds', no decoupled FTS/legacy markers,
    // no idx_backfills_pending, and legacy moderation_effective_labels view
    // referencing moderation_overrides.
    await setMeta(real, "schema_fingerprint", "legacy-0.29.1-fp:cursor-observations-v1");
    await real
      .prepare("DELETE FROM _contrail_meta WHERE key IN (?, ?)")
      .bind(FTS_FINGERPRINTS_KEY, LEGACY_MIGRATIONS_KEY)
      .run();
    await real.prepare("DROP INDEX idx_backfills_pending").run();
    await real
      .prepare(
        "CREATE TABLE moderation_overrides (uri TEXT PRIMARY KEY, moderator TEXT NOT NULL, subject TEXT NOT NULL, val TEXT NOT NULL, cts INTEGER NOT NULL)",
      )
      .run();
    await real.prepare("DROP VIEW moderation_effective_labels").run();
    await real
      .prepare(
        `CREATE VIEW moderation_effective_labels AS
         SELECT l.* FROM labels l
         WHERE NOT EXISTS (SELECT 1 FROM moderation_overrides o WHERE o.subject = l.uri)`,
      )
      .run();

    const upgraded = recordingDb(real);
    await initSchema(upgraded.db, searchConfig);

    const sqlLog = upgraded.prepares.join("\n");
    expect(sqlLog).not.toMatch(/DELETE FROM fts_|INSERT INTO fts_/i);
    expect(sqlLog).not.toMatch(/UPDATE record_versions|INSERT INTO record_versions/i);
    expect(sqlLog).not.toMatch(/UPDATE labels SET cts/i);

    // Additive index and refreshed moderation view are installed.
    expect(
      await real
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_backfills_pending'")
        .first(),
    ).toBeTruthy();
    await real.prepare("DROP TABLE moderation_overrides").run();
    expect(
      (await real.prepare("SELECT * FROM moderation_effective_labels").all()).results,
    ).toEqual([]);

    // Decoupled markers are stamped and existing data/search/cursor survive.
    expect(await getMeta(real, FTS_FINGERPRINTS_KEY)).toBeTruthy();
    expect(await getMeta(real, LEGACY_MIGRATIONS_KEY)).toBeTruthy();
    expect(await getLastCursor(real)).toBe(77_000);
    expect(
      (await queryRecords(real, searchConfig, { collection: "event", search: "LegacyUpgradeEvent" }))
        .records,
    ).toHaveLength(1);

    // Subsequent init returns to the 1-query steady state.
    const steady = recordingDb(real);
    await initSchema(steady.db, searchConfig);
    expect(steady.prepares).toHaveLength(1);
  });
});
