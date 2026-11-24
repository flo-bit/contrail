import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createPostgresDatabase } from "../src/adapters/postgres";
import {
  initSchema,
  resolveConfig,
  ingestRecords,
} from "../src/index";
import { pruneGrownFeeds } from "../src/core/db/records";
import { runGatedFeedPrune } from "../src/core/maintenance";
import type { Database, IngestEvent, Statement } from "../src/index";

// The grown-feed prune on Postgres: the same cases as feed-prune.test.ts, plus
// a check that its follower lookup and cutoff delete can use their indexes
// (the SQLite guardrail can't see Postgres plans).

const EVENT = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";
const FOLLOW = "app.bsky.graph.follow";

const CONFIG = resolveConfig({
  namespace: "com.example",
  collections: {
    event: { collection: EVENT },
    rsvp: { collection: RSVP },
  },
  feeds: {
    main: {
      targets: [
        { collection: "event", maxItems: 2 },
        { collection: "rsvp", maxItems: 3 },
      ],
    },
  },
});

const PG_URL = process.env.TEST_DATABASE_URL;
if (!PG_URL) {
  describe.skip("grown-feed prune on PostgreSQL (TEST_DATABASE_URL not set)", () => {
    it("skipped", () => {});
  });
} else {
  // One connection, so a session setting like enable_seqscan applies to every
  // statement the test issues.
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 1 });
    db = createPostgresDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("RESET enable_seqscan");
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    for (const { tablename } of tables.rows) {
      await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
    }
    await initSchema(db, CONFIG);
  });

  async function seed(actor: string, collection: string, count: number) {
    for (let i = 0; i < count; i++) {
      await db
        .prepare(
          "INSERT INTO feed_items (actor, uri, collection, time_us) VALUES (?, ?, ?, ?)"
        )
        .bind(actor, `at://${actor}/${collection}/${i}`, collection, 1000 + i)
        .run();
    }
  }

  async function rows(actor: string, collection: string): Promise<number[]> {
    const res = await db
      .prepare(
        "SELECT time_us FROM feed_items WHERE actor = ? AND collection = ? ORDER BY time_us DESC"
      )
      .bind(actor, collection)
      .all<{ time_us: number }>();
    return (res.results ?? []).map((r) => Number(r.time_us));
  }

  async function follow(follower: string, subject: string) {
    await db
      .prepare(
        "INSERT INTO records_follow (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        `at://${follower}/${FOLLOW}/${subject}`,
        follower,
        subject,
        "bafyfollow",
        JSON.stringify({ subject }),
        1000,
        1000
      )
      .run();
  }

  function applied(
    did: string,
    collection: string,
    operation: "create" | "update" | "delete",
    record?: object
  ): IngestEvent {
    return {
      uri: `at://${did}/${collection}/r1`,
      did,
      collection,
      rkey: "r1",
      cid: operation === "delete" ? null : "bafy",
      record: record ? JSON.stringify(record) : null,
      time_us: 9000,
      indexed_at: 9000,
      operation,
    };
  }

  /** Record each statement's SQL and bound values while still running it. */
  function recording(real: Database) {
    const calls: { sql: string; args: unknown[] }[] = [];
    const wrapped: Database = {
      prepare(sql: string): Statement {
        const stmt = real.prepare(sql);
        return {
          ...stmt,
          bind(...args: unknown[]) {
            calls.push({ sql, args });
            return stmt.bind(...args);
          },
        };
      },
      batch: (stmts) => real.batch(stmts),
      dialect: real.dialect,
    };
    return { db: wrapped, calls };
  }

  async function plan(sql: string, args: unknown[]): Promise<string> {
    const res = await db
      .prepare("EXPLAIN " + sql)
      .bind(...args)
      .all<{ "QUERY PLAN": string }>();
    return (res.results ?? []).map((r) => r["QUERY PLAN"]).join(" | ");
  }

  describe("pruneGrownFeeds on PostgreSQL", () => {
    it("prunes the author's followers for the collections the batch wrote, and no one else", async () => {
      await follow("alice", "bob");
      await follow("carol", "bob");
      await seed("alice", EVENT, 5);
      await seed("alice", RSVP, 5);
      await seed("carol", EVENT, 5);
      await seed("dave", EVENT, 5);

      const res = await pruneGrownFeeds(db, CONFIG, [applied("bob", EVENT, "create")], 100);

      expect(res).toEqual({ pruned: 6, overflow: false });
      expect(await rows("alice", EVENT)).toEqual([1004, 1003]);
      expect(await rows("carol", EVENT)).toHaveLength(2);
      expect(await rows("alice", RSVP)).toHaveLength(5);
      expect(await rows("dave", EVENT)).toHaveLength(5);
    });

    it("prunes new and repointed followers for every target", async () => {
      await follow("alice", "carol"); // repointed from bob in this batch
      await seed("alice", EVENT, 5);
      await seed("erin", RSVP, 6);
      const res = await pruneGrownFeeds(
        db,
        CONFIG,
        [
          applied("bob", EVENT, "create"),
          applied("alice", FOLLOW, "update", { subject: "carol" }),
          applied("erin", FOLLOW, "create", { subject: "bob" }),
        ],
        100
      );
      expect(res).toEqual({ pruned: 3 + 3, overflow: false });
      expect(await rows("alice", EVENT)).toHaveLength(2);
      expect(await rows("erin", RSVP)).toHaveLength(3);
    });

    it("finds followers across lookup chunks", async () => {
      const authors = Array.from({ length: 60 }, (_, i) => `author-${String(i).padStart(2, "0")}`);
      for (const a of authors) {
        await follow(`f-${a}`, a);
        await seed(`f-${a}`, EVENT, 3);
      }
      const res = await pruneGrownFeeds(
        db,
        CONFIG,
        authors.map((a) => applied(a, EVENT, "create")),
        1000
      );
      expect(res).toEqual({ pruned: 60, overflow: false });
      for (const a of authors) expect(await rows(`f-${a}`, EVENT)).toHaveLength(2);
    });

    it("prunes at most `limit` feeds and reports overflow", async () => {
      for (const f of ["f1", "f2", "f3"]) {
        await follow(f, "bob");
        await seed(f, EVENT, 5);
      }
      const res = await pruneGrownFeeds(db, CONFIG, [applied("bob", EVENT, "create")], 2);
      expect(res).toEqual({ pruned: 2 * 3, overflow: true });
    });

    it("prunes what real ingestion grew: a fan-out and a follow backfill", async () => {
      const [alice, bob, carol, erin] = ["did:plc:alice", "did:plc:bob", "did:plc:carol", "did:plc:erin"];
      await runGatedFeedPrune(db, CONFIG, []); // stamp the recovery clock
      await ingestRecords(db, [{ ...applied(bob, EVENT, "create", { name: "x" }), time_us: 8000 }], CONFIG);
      await follow(alice, carol);
      await seed(alice, EVENT, 2);
      await seed(erin, EVENT, 2);
      await seed("dave", EVENT, 5);

      const { accepted } = await ingestRecords(
        db,
        [
          applied(carol, EVENT, "create", { name: "y" }),
          { ...applied(erin, FOLLOW, "create", { subject: bob }), time_us: 9001 },
        ],
        CONFIG,
        { knownDids: new Set([bob, erin]) }
      );
      expect(await rows(alice, EVENT)).toHaveLength(3);
      expect(await rows(erin, EVENT)).toHaveLength(3);

      await runGatedFeedPrune(db, CONFIG, accepted);
      expect(await rows(alice, EVENT)).toEqual([9000, 1001]);
      expect(await rows(erin, EVENT)).toEqual([8000, 1001]);
      expect(await rows("dave", EVENT)).toHaveLength(5);
    });

    it("can run the lookup on idx_follow_subject and the delete on an index", async () => {
      await follow("alice", "bob");
      await seed("alice", EVENT, 5);
      const { db: rec, calls } = recording(db);
      await pruneGrownFeeds(rec, CONFIG, [applied("bob", EVENT, "create")], 100);
      const lookup = calls.find((c) => /records_follow/i.test(c.sql))!;
      const cutoff = calls.find((c) => /DELETE FROM feed_items/i.test(c.sql))!;

      // With sequential scans priced out, a plan still shows one only if the
      // statement can't use an index. The delete may pick either feed_items
      // index on (actor, ...) depending on the data, so it is not pinned.
      await db.prepare("SET enable_seqscan = off").run();
      expect(await plan(lookup.sql, lookup.args)).toMatch(/idx_follow_subject/);
      expect(await plan(cutoff.sql, cutoff.args)).not.toMatch(/Seq Scan/);
    });
  });
}
