/**
 * End-to-end test exercising the full Contrail lifecycle on PostgreSQL.
 *
 * Covers: schema init, event ingestion, upserts, deletes, relation counts,
 * JSON filters, range filters, pagination, sorting, cursor keyset, FTS via
 * tsvector, and hydration — all against a real PostgreSQL database.
 *
 * Requires TEST_DATABASE_URL env var pointing at a dedicated test database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createPostgresDatabase } from "../src/adapters/postgres";
import { initSchema } from "../src/core/db/schema";
import {
  applyEvents,
  queryRecords,
  getLastCursor,
  saveCursor,
} from "../src/core/db/records";
import { resolveConfig } from "../src/core/types";
import type { Database } from "../src/core/types";
import { resolveHydrates, resolveReferences } from "../src/core/router/hydrate";
import { makeEvent } from "./helpers";

const TEST_CONFIG = resolveConfig({
  namespace: "com.example",
  collections: {
    "community.lexicon.calendar.event": {
      queryable: {
        mode: {},
        name: {},
        startsAt: { type: "range" },
      },
      searchable: ["name", "description"],
      relations: {
        rsvps: {
          collection: "community.lexicon.calendar.rsvp",
          groupBy: "status",
          groups: {
            interested: "community.lexicon.calendar.rsvp#interested",
            going: "community.lexicon.calendar.rsvp#going",
            notgoing: "community.lexicon.calendar.rsvp#notgoing",
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
  describe.skip("PostgreSQL e2e (TEST_DATABASE_URL not set)", () => {
    it("skipped", () => {});
  });
} else {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query("SELECT 1");
    db = createPostgresDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function resetSchema() {
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
       AND (tablename LIKE 'records_%' OR tablename LIKE 'fts_%'
            OR tablename IN ('backfills', 'discovery', 'cursor', 'identities', 'feed_items', 'feed_backfills'))`
    );
    for (const { tablename } of tables.rows) {
      await pool.query(`DROP TABLE IF EXISTS ${tablename} CASCADE`);
    }
    await initSchema(db, TEST_CONFIG);
  }

  beforeEach(resetSchema);

  // --- Schema ---

  describe("schema", () => {
    it("creates collection tables", async () => {
      const result = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'records_%' ORDER BY tablename"
      );
      const names = result.rows.map((r: any) => r.tablename);
      expect(names).toContain("records_community_lexicon_calendar_event");
      expect(names).toContain("records_community_lexicon_calendar_rsvp");
    });

    it("creates indexes for queryable fields", async () => {
      const result = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_community_lexicon_calendar_event_%'"
      );
      const names = result.rows.map((r: any) => r.indexname);
      expect(names).toContain("idx_community_lexicon_calendar_event_mode");
      // PostgreSQL lowercases unquoted identifiers
      expect(names).toContain("idx_community_lexicon_calendar_event_startsat");
    });

    it("creates tsvector search column", async () => {
      const result = await pool.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'records_community_lexicon_calendar_event' AND column_name = 'search_vector'"
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].data_type).toBe("tsvector");
    });

    it("is idempotent", async () => {
      await initSchema(db, TEST_CONFIG);
      await initSchema(db, TEST_CONFIG);
      const result = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'records_%'"
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  // --- CRUD & Ingestion ---

  describe("ingestion", () => {
    it("inserts create events", async () => {
      await applyEvents(db, [
        makeEvent({ record: { name: "Event 1", mode: "online" } }),
      ]);
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      expect(result.records).toHaveLength(1);
      expect(JSON.parse(result.records[0].record!).name).toBe("Event 1");
    });

    it("upserts on conflict", async () => {
      const uri = "at://did:plc:test/community.lexicon.calendar.event/1";
      await applyEvents(db, [
        makeEvent({ uri, rkey: "1", cid: "cid1", record: { name: "V1", mode: "online" } }),
      ]);
      await applyEvents(db, [
        makeEvent({ uri, rkey: "1", cid: "cid2", record: { name: "V2", mode: "online" } }),
      ]);
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      expect(result.records).toHaveLength(1);
      expect(JSON.parse(result.records[0].record!).name).toBe("V2");
    });

    it("deletes events", async () => {
      const uri = "at://did:plc:test/community.lexicon.calendar.event/1";
      await applyEvents(db, [
        makeEvent({ uri, rkey: "1", record: { name: "Gone", mode: "online" } }),
      ]);
      await applyEvents(db, [
        makeEvent({ uri, rkey: "1", operation: "delete", record: null, cid: null }),
      ]);
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      expect(result.records).toHaveLength(0);
    });

    it("does nothing for empty events", async () => {
      await applyEvents(db, []);
      const cursor = await getLastCursor(db);
      expect(cursor).toBeNull();
    });
  });

  // --- Counts ---

  describe("relation counts", () => {
    const eventUri = "at://did:plc:host/community.lexicon.calendar.event/evt1";

    beforeEach(async () => {
      await applyEvents(db, [
        makeEvent({ uri: eventUri, rkey: "evt1", record: { name: "Counted Event", mode: "online" } }),
      ]);
    });

    it("increments counts on RSVP create", async () => {
      await applyEvents(db, [
        makeEvent({
          uri: "at://did:plc:u1/community.lexicon.calendar.rsvp/r1",
          did: "did:plc:u1",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: { subject: { uri: eventUri }, status: "community.lexicon.calendar.rsvp#going" },
          time_us: 2000000,
        }),
        makeEvent({
          uri: "at://did:plc:u2/community.lexicon.calendar.rsvp/r2",
          did: "did:plc:u2",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r2",
          record: { subject: { uri: eventUri }, status: "community.lexicon.calendar.rsvp#going" },
          time_us: 3000000,
        }),
        makeEvent({
          uri: "at://did:plc:u3/community.lexicon.calendar.rsvp/r3",
          did: "did:plc:u3",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r3",
          record: { subject: { uri: eventUri }, status: "community.lexicon.calendar.rsvp#interested" },
          time_us: 4000000,
        }),
      ], TEST_CONFIG);

      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      expect(result.records[0].counts?.["community.lexicon.calendar.rsvp"]).toBe(3);
      expect(result.records[0].counts?.["community.lexicon.calendar.rsvp#going"]).toBe(2);
      expect(result.records[0].counts?.["community.lexicon.calendar.rsvp#interested"]).toBe(1);
    });

    it("decrements counts on RSVP delete", async () => {
      const rsvpUri = "at://did:plc:u1/community.lexicon.calendar.rsvp/r1";
      await applyEvents(db, [
        makeEvent({
          uri: rsvpUri,
          did: "did:plc:u1",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: { subject: { uri: eventUri }, status: "community.lexicon.calendar.rsvp#going" },
          time_us: 2000000,
        }),
      ], TEST_CONFIG);

      // Verify count is 1
      let result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      expect(result.records[0].counts?.["community.lexicon.calendar.rsvp"]).toBe(1);

      // Delete the RSVP
      await applyEvents(db, [
        makeEvent({
          uri: rsvpUri,
          did: "did:plc:u1",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          operation: "delete",
          record: null,
          cid: null,
          time_us: 3000000,
        }),
      ], TEST_CONFIG);

      result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      // Count should be 0 (absent from counts map)
      expect(result.records[0].counts?.["community.lexicon.calendar.rsvp"]).toBeUndefined();
    });
  });

  // --- Querying ---

  describe("queries", () => {
    beforeEach(async () => {
      await applyEvents(db, [
        makeEvent({ uri: "at://a/community.lexicon.calendar.event/1", rkey: "1", did: "did:plc:alice", record: { name: "Alpha", mode: "online", startsAt: "2026-04-01T10:00:00Z" }, time_us: 1000 }),
        makeEvent({ uri: "at://a/community.lexicon.calendar.event/2", rkey: "2", did: "did:plc:bob", record: { name: "Beta", mode: "in-person", startsAt: "2026-05-01T10:00:00Z" }, time_us: 2000 }),
        makeEvent({ uri: "at://a/community.lexicon.calendar.event/3", rkey: "3", did: "did:plc:alice", record: { name: "Gamma", mode: "online", startsAt: "2026-06-01T10:00:00Z" }, time_us: 3000 }),
        makeEvent({ uri: "at://a/community.lexicon.calendar.event/4", rkey: "4", did: "did:plc:carol", record: { name: "Delta", mode: "hybrid", startsAt: "2026-03-01T10:00:00Z" }, time_us: 4000 }),
      ]);
    });

    it("returns records ordered by time_us desc", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      expect(result.records).toHaveLength(4);
      expect(result.records[0].rkey).toBe("4"); // highest time_us
      expect(result.records[3].rkey).toBe("1"); // lowest time_us
    });

    it("filters by did", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        did: "did:plc:alice",
      });
      expect(result.records).toHaveLength(2);
    });

    it("filters by equality", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        filters: { mode: "online" },
      });
      expect(result.records).toHaveLength(2);
    });

    it("filters by range", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        rangeFilters: {
          startsAt: { min: "2026-04-01T00:00:00Z", max: "2026-05-31T23:59:59Z" },
        },
      });
      expect(result.records).toHaveLength(2);
    });

    it("respects limit", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        limit: 2,
      });
      expect(result.records).toHaveLength(2);
      expect(result.cursor).toBeDefined();
    });

    it("paginates with cursor", async () => {
      const page1 = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        limit: 2,
      });
      expect(page1.records).toHaveLength(2);
      expect(page1.cursor).toBeDefined();

      const page2 = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        limit: 2,
        cursor: page1.cursor,
      });
      expect(page2.records).toHaveLength(2);

      // No overlap
      const page1Uris = page1.records.map(r => r.uri);
      const page2Uris = page2.records.map(r => r.uri);
      expect(page1Uris.filter(u => page2Uris.includes(u))).toHaveLength(0);
    });

    it("sorts by record field asc", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        sort: { recordField: "startsAt", direction: "asc" },
      });
      const dates = result.records.map(r => JSON.parse(r.record!).startsAt);
      expect(dates).toEqual([...dates].sort());
    });

    it("sorts by record field desc", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        sort: { recordField: "startsAt", direction: "desc" },
      });
      const dates = result.records.map(r => JSON.parse(r.record!).startsAt);
      expect(dates).toEqual([...dates].sort().reverse());
    });

    it("returns no cursor when all results fit", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        limit: 100,
      });
      expect(result.cursor).toBeUndefined();
    });
  });

  // --- FTS ---

  describe("full-text search", () => {
    beforeEach(async () => {
      await applyEvents(db, [
        makeEvent({ uri: "at://a/community.lexicon.calendar.event/1", rkey: "1", record: { name: "Rust Meetup", description: "Systems programming", mode: "online" }, time_us: 1000 }),
        makeEvent({ uri: "at://a/community.lexicon.calendar.event/2", rkey: "2", record: { name: "TypeScript Workshop", description: "Learn web dev", mode: "online" }, time_us: 2000 }),
        makeEvent({ uri: "at://a/community.lexicon.calendar.event/3", rkey: "3", record: { name: "Go Conference", description: "Concurrency and systems", mode: "in-person" }, time_us: 3000 }),
      ], TEST_CONFIG);
    });

    it("finds records matching a search term", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        search: "Rust",
      });
      expect(result.records).toHaveLength(1);
      expect(JSON.parse(result.records[0].record!).name).toBe("Rust Meetup");
    });

    it("searches across multiple fields", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        search: "systems",
      });
      // "systems" appears in description of Rust Meetup and Go Conference
      expect(result.records).toHaveLength(2);
    });

    it("returns nothing for non-matching search", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        search: "python",
      });
      expect(result.records).toHaveLength(0);
    });

    it("combines search with filters", async () => {
      const result = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
        search: "systems",
        filters: { mode: "in-person" },
      });
      expect(result.records).toHaveLength(1);
      expect(JSON.parse(result.records[0].record!).name).toBe("Go Conference");
    });
  });

  // --- Hydration ---

  describe("hydration", () => {
    const eventUri1 = "at://did:plc:host/community.lexicon.calendar.event/evt1";
    const eventUri2 = "at://did:plc:host/community.lexicon.calendar.event/evt2";

    beforeEach(async () => {
      await applyEvents(db, [
        makeEvent({ uri: eventUri1, rkey: "evt1", record: { name: "Event 1", mode: "online" }, time_us: 1000 }),
        makeEvent({ uri: eventUri2, rkey: "evt2", record: { name: "Event 2", mode: "online" }, time_us: 2000 }),
      ]);
      await applyEvents(db, [
        makeEvent({
          uri: "at://did:plc:u1/community.lexicon.calendar.rsvp/r1",
          did: "did:plc:u1",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r1",
          record: { subject: { uri: eventUri1 }, status: "community.lexicon.calendar.rsvp#going" },
          time_us: 3000,
        }),
        makeEvent({
          uri: "at://did:plc:u2/community.lexicon.calendar.rsvp/r2",
          did: "did:plc:u2",
          collection: "community.lexicon.calendar.rsvp",
          rkey: "r2",
          record: { subject: { uri: eventUri1 }, status: "community.lexicon.calendar.rsvp#interested" },
          time_us: 4000,
        }),
      ], TEST_CONFIG);
    });

    it("hydrates related records", async () => {
      const events = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.event",
      });
      const hydrated = await resolveHydrates(
        db,
        TEST_CONFIG.collections["community.lexicon.calendar.event"].relations!,
        { rsvps: 10 },
        events.records
      );
      // Event 1 has 2 RSVPs in 2 groups
      expect(hydrated[eventUri1]).toBeDefined();
      const rsvps = hydrated[eventUri1].rsvps as Record<string, any[]>;
      const totalRsvps = Object.values(rsvps).flat().length;
      expect(totalRsvps).toBe(2);
    });

    it("resolves references (child → parent)", async () => {
      const rsvps = await queryRecords(db, TEST_CONFIG, {
        collection: "community.lexicon.calendar.rsvp",
      });
      const refs = await resolveReferences(
        db,
        TEST_CONFIG.collections["community.lexicon.calendar.rsvp"].references!,
        new Set(["event"]),
        rsvps.records
      );
      // Both RSVPs point at eventUri1
      for (const rsvp of rsvps.records) {
        expect(refs[rsvp.uri]?.event).toBeDefined();
        expect(refs[rsvp.uri].event.uri).toBe(eventUri1);
      }
    });
  });

  // --- Cursor ---

  describe("cursor persistence", () => {
    it("saves and retrieves cursor", async () => {
      await saveCursor(db, 12345);
      expect(await getLastCursor(db)).toBe(12345);
    });

    it("updates existing cursor", async () => {
      await saveCursor(db, 100);
      await saveCursor(db, 200);
      expect(await getLastCursor(db)).toBe(200);
    });

    it("returns null when no cursor", async () => {
      expect(await getLastCursor(db)).toBeNull();
    });
  });
}
