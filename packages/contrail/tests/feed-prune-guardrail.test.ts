import { describe, it, expect, beforeEach } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import type {
  Database,
  Statement,
  ResolvedContrailConfig,
  IngestEvent,
} from "../src/core/types";
import { resolveConfig } from "../src/core/types";
import { initSchema } from "../src/core/db/schema";
import {
  applyEvents,
  sweepFeedItems,
  pruneActorFeed,
  pruneFeedItems,
} from "../src/core/db/records";

// ---------------------------------------------------------------------------
// Guardrail: no contrail-issued maintenance statement may be unbounded-O(n)
// over a table. A single full-table SCAN can exhaust D1's per-query CPU budget
// and reset the shared Durable Object, which kills every concurrent read on the
// same SQLite instance (the feed-prune outage). This test exercises the real
// prune + feed-fanout code, captures every SQL it issues, and asserts each one
// is index-bounded via EXPLAIN QUERY PLAN.
// ---------------------------------------------------------------------------

const EVENT = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";
const FOLLOW = "app.bsky.graph.follow";

const CONFIG: ResolvedContrailConfig = resolveConfig({
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

const CAPS = new Map<string, number>([
  [EVENT, 2],
  [RSVP, 3],
]);

/** Wrap a Database so every SQL string passed to prepare() is recorded, while
 *  delegating to the real DB so the exercised code still reads/writes data. */
function recordingDb(real: Database): { db: Database; sqls: string[] } {
  const sqls: string[] = [];
  const db: Database = {
    prepare(sql: string): Statement {
      sqls.push(sql);
      return real.prepare(sql);
    },
    batch(stmts: Statement[]): Promise<any[]> {
      return real.batch(stmts);
    },
    dialect: real.dialect,
  };
  return { db, sqls };
}

/** Return the EXPLAIN QUERY PLAN `detail` lines for a statement. Params are
 *  irrelevant to the plan, so we bind dummy values to satisfy the placeholders. */
async function queryPlan(db: Database, sql: string): Promise<string[]> {
  const placeholders = (sql.match(/\?/g) ?? []).length;
  const binds = Array.from({ length: placeholders }, () => 1);
  const res = await db
    .prepare("EXPLAIN QUERY PLAN " + sql)
    .bind(...binds)
    .all<{ detail: string }>();
  return (res.results ?? []).map((r) => r.detail);
}

/**
 * Plan lines that represent an UNBOUNDED full-table scan: a `SCAN <table>` that
 * is not driven by an index. Index SEARCHes and LIMIT-bounded index SCANs are
 * fine — their cost is keyed/bounded, not proportional to the whole table.
 */
function unboundedScans(plan: string[]): string[] {
  return plan.filter(
    (d) => /^SCAN\b/i.test(d.trim()) && !/\bINDEX\b/i.test(d)
  );
}

/** Statements with no rows in their plan (e.g. INSERT ... VALUES) read nothing. */
async function assertAllBounded(db: Database, sqls: string[]): Promise<void> {
  for (const sql of [...new Set(sqls)]) {
    const plan = await queryPlan(db, sql);
    const bad = unboundedScans(plan);
    expect(
      bad,
      `Unbounded full-table scan in maintenance SQL:\n  ${sql}\n  plan: ${plan.join(" | ")}`
    ).toEqual([]);
  }
}

function makeFollowRow(db: Database, follower: string, subject: string) {
  return db
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

let real: Database;

beforeEach(async () => {
  real = createSqliteDatabase(":memory:");
  await initSchema(real, CONFIG);
});

describe("feed maintenance stays index-bounded", () => {
  it("sweepFeedItems issues only index-bounded statements", async () => {
    // Several actors over cap so the sweep actually deletes.
    for (const a of ["did:plc:a", "did:plc:b", "did:plc:c"]) {
      for (let i = 0; i < 6; i++) {
        await real
          .prepare(
            "INSERT INTO feed_items (actor, uri, collection, time_us) VALUES (?, ?, ?, ?)"
          )
          .bind(a, `at://${a}/e/${i}`, EVENT, 1000 + i)
          .run();
      }
    }

    const { db, sqls } = recordingDb(real);
    const res = await sweepFeedItems(db, CAPS, null, 100);
    expect(res.pruned).toBeGreaterThan(0);
    expect(sqls.length).toBeGreaterThan(0);
    await assertAllBounded(real, sqls);
  });

  it("pruneActorFeed / pruneFeedItems issue only index-bounded statements", async () => {
    for (let i = 0; i < 8; i++) {
      await real
        .prepare(
          "INSERT INTO feed_items (actor, uri, collection, time_us) VALUES (?, ?, ?, ?)"
        )
        .bind("did:plc:z", `at://did:plc:z/e/${i}`, EVENT, 2000 + i)
        .run();
    }

    const a = recordingDb(real);
    await pruneActorFeed(a.db, "did:plc:z", EVENT, 2);
    await assertAllBounded(real, a.sqls);

    const b = recordingDb(real);
    await pruneFeedItems(b.db, CAPS);
    await assertAllBounded(real, b.sqls);
  });

  it("feed fan-out on a target create issues only index-bounded statements", async () => {
    // A follower pointing at the event's author, so the fan-out has work.
    await makeFollowRow(real, "did:plc:follower", "did:plc:author");

    const { db, sqls } = recordingDb(real);
    const event: IngestEvent = {
      uri: "at://did:plc:author/" + EVENT + "/evt1",
      did: "did:plc:author",
      collection: EVENT,
      rkey: "evt1",
      cid: "bafyevt",
      record: JSON.stringify({ name: "Party", startsAt: "2026-04-01T10:00:00Z" }),
      time_us: 5000,
      indexed_at: 5000,
      operation: "create",
    };
    await applyEvents(db, [event], CONFIG);

    // The fan-out INSERT must have been issued and it must hit the table.
    const fanout = sqls.find((s) => /INSERT.*feed_items/is.test(s));
    expect(fanout, "expected a feed_items fan-out INSERT").toBeTruthy();
    expect((await real.prepare("SELECT COUNT(*) AS c FROM feed_items").first<{ c: number }>())?.c).toBe(1);

    await assertAllBounded(real, sqls);
  });

  it("the fan-out follower lookup uses idx_follow_subject (not a full scan)", async () => {
    await makeFollowRow(real, "did:plc:follower", "did:plc:author");

    const { db, sqls } = recordingDb(real);
    await applyEvents(
      db,
      [
        {
          uri: "at://did:plc:author/" + EVENT + "/evt2",
          did: "did:plc:author",
          collection: EVENT,
          rkey: "evt2",
          cid: "bafyevt2",
          record: JSON.stringify({ name: "x" }),
          time_us: 6000,
          indexed_at: 6000,
          operation: "create",
        },
      ],
      CONFIG
    );

    const fanout = sqls.find((s) => /records_follow/is.test(s))!;
    const plan = (await queryPlan(real, fanout)).join(" | ");
    expect(plan).toMatch(/idx_follow_subject/i);
  });
});

describe("the guardrail has teeth", () => {
  it("rejects the old global window + anti-join prune", async () => {
    // The original pruneFeedItems statement that reset the D1 DO in production.
    const oldGlobalPrune = `DELETE FROM feed_items WHERE collection = ? AND (actor, uri) NOT IN (
        SELECT actor, uri FROM (
          SELECT actor, uri, ROW_NUMBER() OVER (PARTITION BY actor ORDER BY time_us DESC) as rn
          FROM feed_items WHERE collection = ?
        ) sub WHERE rn <= ?
      )`;
    const plan = await queryPlan(real, oldGlobalPrune);
    // It must trip the guard with at least one full-table SCAN of feed_items.
    expect(unboundedScans(plan).length).toBeGreaterThan(0);
  });

  it("flags a contrived unindexed scan", async () => {
    const plan = await queryPlan(
      real,
      "SELECT * FROM feed_items WHERE time_us = ?"
    );
    expect(unboundedScans(plan).length).toBeGreaterThan(0);
  });
});
