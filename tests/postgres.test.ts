import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createPostgresDatabase } from "../src/adapters/postgres";
import { initSchema } from "../src/core/db/schema";
import { applyEvents, queryRecords, getLastCursor, saveCursor } from "../src/core/db/records";
import { resolveConfig } from "../src/core/types";
import { makeEvent } from "./helpers";

const TEST_CONFIG = resolveConfig({
  namespace: "com.example",
  collections: {
    "community.lexicon.calendar.event": {
      queryable: { mode: {}, name: {}, startsAt: { type: "range" } },
      searchable: ["name", "description"],
      relations: {
        rsvps: {
          collection: "community.lexicon.calendar.rsvp",
          groupBy: "status",
          groups: {
            going: "community.lexicon.calendar.rsvp#going",
          },
        },
      },
    },
    "community.lexicon.calendar.rsvp": {
      references: {
        event: {
          collection: "community.lexicon.calendar.event",
          field: "subject.uri",
        },
      },
    },
  },
});

const PG_URL = process.env.TEST_DATABASE_URL;
if (!PG_URL) {
  describe.skip("PostgreSQL adapter (TEST_DATABASE_URL not set)", () => {
    it("skipped", () => {});
  });
} else {
  let pool: pg.Pool;
  let db: ReturnType<typeof createPostgresDatabase>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query("SELECT 1");
    db = createPostgresDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // Drop all contrail tables
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
       AND (tablename LIKE 'records_%' OR tablename LIKE 'fts_%'
            OR tablename IN ('backfills', 'discovery', 'cursor', 'identities', 'feed_items', 'feed_backfills'))`
    );
    for (const { tablename } of tables.rows) {
      await pool.query(`DROP TABLE IF EXISTS ${tablename} CASCADE`);
    }
    await initSchema(db, TEST_CONFIG);
  });

  describe("PostgreSQL adapter", () => {
    it("initializes schema", async () => {
      const result = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'records_%'"
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(2);
    });

    it("saves and retrieves cursor", async () => {
      await saveCursor(db, 12345);
      expect(await getLastCursor(db)).toBe(12345);
    });

    it("inserts and queries records", async () => {
      await applyEvents(db, [makeEvent({ record: { name: "PG Test", mode: "online" } })]);
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      expect(result.records).toHaveLength(1);
    });

    it("filters by json field", async () => {
      await applyEvents(db, [
        makeEvent({ uri: "at://a/community.lexicon.calendar.event/1", rkey: "1", record: { name: "A", mode: "online" }, time_us: 2000 }),
        makeEvent({ uri: "at://a/community.lexicon.calendar.event/2", rkey: "2", record: { name: "B", mode: "in-person" }, time_us: 1000 }),
      ]);
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        filters: { mode: "online" },
      });
      expect(result.records).toHaveLength(1);
    });

    it("counts relations", async () => {
      const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";
      await applyEvents(db, [makeEvent({ uri: eventUri, rkey: "evt1" })]);
      await applyEvents(db, [
        makeEvent({
          uri: "at://did:plc:user1/community.lexicon.calendar.rsvp/r1",
          did: "did:plc:user1",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: { subject: { uri: eventUri }, status: "community.lexicon.calendar.rsvp#going" },
          time_us: 2000000,
        }),
      ], TEST_CONFIG);

      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      expect(result.records[0].counts?.["community.lexicon.calendar.rsvp"]).toBe(1);
    });

    it("full-text search works via tsvector", async () => {
      await applyEvents(db, [
        makeEvent({
          uri: "at://a/community.lexicon.calendar.event/1",
          rkey: "1",
          record: { name: "Rust Meetup", description: "A gathering of Rustaceans", mode: "online" },
          time_us: 2000,
        }),
        makeEvent({
          uri: "at://a/community.lexicon.calendar.event/2",
          rkey: "2",
          record: { name: "TypeScript Workshop", description: "Learn TS", mode: "online" },
          time_us: 1000,
        }),
      ], TEST_CONFIG);

      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        search: "Rust",
      });
      expect(result.records).toHaveLength(1);
      expect(JSON.parse(result.records[0].record!).name).toBe("Rust Meetup");
    });
  });
}
