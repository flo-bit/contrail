import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import type { Database, ResolvedContrailConfig } from "../src/index";
import { resolveConfig } from "../src/index";
import { initSchema } from "../src/index";
import {
  pruneActorFeed,
  sweepFeedItems,
  pruneFeedItems,
  getFeedPruneCursor,
  saveFeedPruneCursor,
} from "../src/core/db/records";
import { ingestRecords } from "../src/index";
import { runGatedFeedPrune, FEED_PRUNE_RECOVERY_INTERVAL_MS } from "../src/core/maintenance";
import { pruneGrownFeeds } from "../src/core/db/records";
import type { IngestEvent, Statement } from "../src/index";

const EVENT = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";
const NOTE = "com.example.note";
const FOLLOW = "app.bsky.graph.follow";

// Feeds config: event capped at 2 per actor, rsvp at 3; note is indexed but is
// not a feed target. resolveConfig auto-adds the `follow` collection, so
// initSchema builds feed_items, the idx_feed_actor_coll_time index, and
// feed_prune_cursor.
const CONFIG: ResolvedContrailConfig = resolveConfig({
  namespace: "com.example",
  collections: {
    event: { collection: EVENT },
    rsvp: { collection: RSVP },
    note: { collection: NOTE },
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

// caps keyed by NSID, matching what buildFeedTargetCaps / the fanout produce.
const CAPS = new Map<string, number>([
  [EVENT, 2],
  [RSVP, 3],
]);

let db: Database;

async function insertItem(
  actor: string,
  collection: string,
  n: number,
  timeUs: number
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO feed_items (actor, uri, collection, time_us) VALUES (?, ?, ?, ?)"
    )
    .bind(actor, `at://${actor}/${collection}/${n}`, collection, timeUs)
    .run();
}

/** Insert `count` items for (actor, collection) with increasing time_us. */
async function seed(
  actor: string,
  collection: string,
  count: number
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await insertItem(actor, collection, i, 1000 + i);
  }
}

async function rows(
  actor: string,
  collection: string
): Promise<number[]> {
  const res = await db
    .prepare(
      "SELECT time_us FROM feed_items WHERE actor = ? AND collection = ? ORDER BY time_us DESC"
    )
    .bind(actor, collection)
    .all<{ time_us: number }>();
  return (res.results ?? []).map((r) => Number(r.time_us));
}

async function follow(follower: string, subject: string): Promise<void> {
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

/** An applied ingest event, as the ingest paths hand it to the prune. */
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

/** Followers of bob whose EVENT feed is still over its cap of 2. */
async function overCapFollowers(): Promise<number> {
  const res = await db
    .prepare(
      "SELECT COUNT(*) AS c FROM (SELECT actor FROM feed_items WHERE collection = ? AND actor LIKE 'f-%' GROUP BY actor HAVING COUNT(*) > 2)"
    )
    .bind(EVENT)
    .first<{ c: number }>();
  return Number(res?.c);
}

beforeEach(async () => {
  db = createSqliteDatabase(":memory:");
  await initSchema(db, CONFIG);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pruneActorFeed", () => {
  it("keeps the newest `cap` rows and deletes the rest", async () => {
    await seed("alice", EVENT, 5); // time_us 1000..1004
    const deleted = await pruneActorFeed(db, "alice", EVENT, 2);
    expect(deleted).toBe(3);
    expect(await rows("alice", EVENT)).toEqual([1004, 1003]);
  });

  it("is a no-op when the actor is at or under cap", async () => {
    await seed("bob", EVENT, 2);
    expect(await pruneActorFeed(db, "bob", EVENT, 2)).toBe(0);
    expect(await pruneActorFeed(db, "bob", EVENT, 5)).toBe(0);
    expect((await rows("bob", EVENT)).length).toBe(2);
  });

  it("only touches the named collection", async () => {
    await seed("alice", EVENT, 4);
    await seed("alice", RSVP, 4);
    await pruneActorFeed(db, "alice", EVENT, 2);
    expect((await rows("alice", EVENT)).length).toBe(2);
    expect((await rows("alice", RSVP)).length).toBe(4); // untouched
  });
});

describe("sweepFeedItems", () => {
  it("prunes every actor to the per-collection caps in one pass", async () => {
    await seed("alice", EVENT, 5);
    await seed("alice", RSVP, 6);
    await seed("bob", EVENT, 1);
    await seed("carol", RSVP, 10);

    const res = await sweepFeedItems(db, CAPS, null, 100);

    expect(res.done).toBe(true);
    expect(res.nextCursor).toBeNull();
    expect(res.pruned).toBe(3 + 3 + 0 + 7); // alice event/rsvp, bob, carol
    expect((await rows("alice", EVENT)).length).toBe(2);
    expect((await rows("alice", RSVP)).length).toBe(3);
    expect((await rows("bob", EVENT)).length).toBe(1);
    expect((await rows("carol", RSVP)).length).toBe(3);
  });

  it("pages by actor and resumes via the cursor", async () => {
    // Three actors, each over the event cap.
    for (const a of ["a-actor", "b-actor", "c-actor"]) await seed(a, EVENT, 5);

    // Budget of 1 actor per slice: first slice handles "a-actor".
    const s1 = await sweepFeedItems(db, CAPS, null, 1);
    expect(s1.done).toBe(false);
    expect(s1.nextCursor).toBe("a-actor");
    expect((await rows("a-actor", EVENT)).length).toBe(2);
    expect((await rows("b-actor", EVENT)).length).toBe(5); // not yet reached

    const s2 = await sweepFeedItems(db, CAPS, s1.nextCursor, 1);
    expect(s2.nextCursor).toBe("b-actor");
    expect((await rows("b-actor", EVENT)).length).toBe(2);

    const s3 = await sweepFeedItems(db, CAPS, s2.nextCursor, 1);
    // Last actor — still a full page, so not yet flagged done.
    expect(s3.nextCursor).toBe("c-actor");
    expect((await rows("c-actor", EVENT)).length).toBe(2);

    // One more slice runs off the end and wraps.
    const s4 = await sweepFeedItems(db, CAPS, s3.nextCursor, 1);
    expect(s4.done).toBe(true);
    expect(s4.nextCursor).toBeNull();
    expect(s4.pruned).toBe(0);
  });

  it("returns done with no work for empty caps", async () => {
    await seed("alice", EVENT, 5);
    const res = await sweepFeedItems(db, new Map(), null, 100);
    expect(res).toEqual({ pruned: 0, nextCursor: null, done: true });
    expect((await rows("alice", EVENT)).length).toBe(5);
  });
});

describe("feed prune cursor", () => {
  it("round-trips and defaults to null", async () => {
    expect(await getFeedPruneCursor(db)).toBeNull();
    await saveFeedPruneCursor(db, "did:plc:xyz");
    expect(await getFeedPruneCursor(db)).toBe("did:plc:xyz");
    await saveFeedPruneCursor(db, null);
    expect(await getFeedPruneCursor(db)).toBeNull();
  });
});

describe("pruneFeedItems (full recovery loop)", () => {
  it("brings an already-bloated table within caps in one call", async () => {
    // Many actors well over cap — the bloated-table recovery scenario.
    for (let i = 0; i < 25; i++) {
      await seed(`actor-${String(i).padStart(2, "0")}`, EVENT, 8);
      await seed(`actor-${String(i).padStart(2, "0")}`, RSVP, 8);
    }
    const total = await pruneFeedItems(db, CAPS);
    expect(total).toBe(25 * (6 + 5)); // event: 8→2, rsvp: 8→3

    const remaining = await db
      .prepare("SELECT COUNT(*) AS c FROM feed_items")
      .first<{ c: number }>();
    expect(Number(remaining?.c)).toBe(25 * (2 + 3));
  });
});

describe("pruneGrownFeeds", () => {
  it("prunes the author's followers for the collections the batch wrote, and no one else", async () => {
    await follow("alice", "bob");
    await follow("carol", "bob");
    await seed("alice", EVENT, 5);
    await seed("alice", RSVP, 5); // bob wrote no rsvp this batch
    await seed("carol", EVENT, 5);
    await seed("dave", EVENT, 5); // over cap, but follows no one in the batch

    const res = await pruneGrownFeeds(db, CONFIG, [applied("bob", EVENT, "create")], 100);

    expect(res).toEqual({ pruned: 6, overflow: false });
    expect(await rows("alice", EVENT)).toEqual([1004, 1003]);
    expect(await rows("carol", EVENT)).toHaveLength(2);
    expect(await rows("alice", RSVP)).toHaveLength(5);
    expect(await rows("dave", EVENT)).toHaveLength(5);
  });

  it("prunes followers for a target update as for a create", async () => {
    await follow("alice", "bob");
    await seed("alice", RSVP, 5);
    await seed("alice", EVENT, 5); // bob updated no event
    const res = await pruneGrownFeeds(db, CONFIG, [applied("bob", RSVP, "update")], 100);
    expect(res).toEqual({ pruned: 2, overflow: false });
    expect(await rows("alice", RSVP)).toHaveLength(3);
    expect(await rows("alice", EVENT)).toHaveLength(5);
  });

  it("prunes a new follower's feed for every target, and no one else", async () => {
    await seed("erin", EVENT, 5);
    await seed("erin", RSVP, 6);
    await seed("frank", EVENT, 5); // over cap, but not in the batch
    const res = await pruneGrownFeeds(
      db,
      CONFIG,
      [applied("erin", FOLLOW, "create", { subject: "bob" })],
      100
    );
    expect(res).toEqual({ pruned: 3 + 3, overflow: false });
    expect(await rows("erin", EVENT)).toHaveLength(2);
    expect(await rows("erin", RSVP)).toHaveLength(3);
    expect(await rows("frank", EVENT)).toHaveLength(5);
  });

  it("prunes a follower whose follow the batch repointed", async () => {
    // In one cron cycle a fan-out from bob reached alice, then a later
    // transaction repointed alice's follow to carol. The lookup of bob's
    // followers no longer finds alice, so her follow update counts as growth.
    await follow("alice", "carol");
    await seed("alice", EVENT, 5);
    await seed("alice", RSVP, 4);
    const res = await pruneGrownFeeds(
      db,
      CONFIG,
      [
        applied("bob", EVENT, "create"),
        applied("alice", FOLLOW, "update", { subject: "carol" }),
      ],
      100
    );
    expect(res).toEqual({ pruned: 3 + 1, overflow: false });
    expect(await rows("alice", EVENT)).toHaveLength(2);
    expect(await rows("alice", RSVP)).toHaveLength(3);
  });

  it("finds followers across lookup chunks, overlapping authors and collections", async () => {
    // 60 authors cross the 50-subject lookup chunk. "shared" follows one author
    // in each chunk, and the second of them also wrote an rsvp.
    const authors = Array.from({ length: 60 }, (_, i) => `author-${String(i).padStart(2, "0")}`);
    for (const a of authors) {
      await follow(`f-${a}`, a);
      await seed(`f-${a}`, EVENT, 3);
    }
    await follow("shared", authors[0]);
    await follow("shared", authors[55]);
    await seed("shared", EVENT, 5);
    await seed("shared", RSVP, 5);
    await seed("dave", EVENT, 5);

    const res = await pruneGrownFeeds(
      db,
      CONFIG,
      [...authors.map((a) => applied(a, EVENT, "create")), applied(authors[55], RSVP, "create")],
      1000
    );

    expect(res).toEqual({ pruned: 60 + 3 + 2, overflow: false });
    for (const a of authors) expect(await rows(`f-${a}`, EVENT)).toHaveLength(2);
    expect(await rows("shared", EVENT)).toHaveLength(2);
    expect(await rows("shared", RSVP)).toHaveLength(3);
    expect(await rows("dave", EVENT)).toHaveLength(5);
  });

  it("issues no statements for a batch that grew no feed", async () => {
    await follow("alice", "bob");
    await seed("alice", EVENT, 5);
    const sqls: string[] = [];
    const recording: Database = {
      prepare(sql: string): Statement {
        sqls.push(sql);
        return db.prepare(sql);
      },
      batch: (stmts) => db.batch(stmts),
      dialect: db.dialect,
    };

    // Deletes only shrink feeds, and a collection that isn't a target never
    // reaches one.
    const res = await pruneGrownFeeds(
      recording,
      CONFIG,
      [
        applied("bob", EVENT, "delete"),
        applied("alice", FOLLOW, "delete"),
        applied("bob", NOTE, "create"),
      ],
      100
    );

    expect(res).toEqual({ pruned: 0, overflow: false });
    expect(sqls).toEqual([]);
    expect(await rows("alice", EVENT)).toHaveLength(5);
  });

  it("prunes at most `limit` feeds and reports overflow", async () => {
    for (const f of ["f1", "f2", "f3"]) {
      await follow(f, "bob");
      await seed(f, EVENT, 5);
    }
    const res = await pruneGrownFeeds(db, CONFIG, [applied("bob", EVENT, "create")], 2);
    expect(res).toEqual({ pruned: 2 * 3, overflow: true });
    const lengths = await Promise.all(["f1", "f2", "f3"].map(async (f) => (await rows(f, EVENT)).length));
    expect(lengths.sort()).toEqual([2, 2, 5]);
  });
});

describe("runGatedFeedPrune (recovery gate)", () => {
  it("sweeps when a full pass is overdue, even with nothing applied", async () => {
    // The persisted recovery clock is unset (0), so a pass is overdue. This is
    // the path a no-op notify call or an idle stream relies on to make progress.
    await seed("alice", EVENT, 5); // cap 2
    await runGatedFeedPrune(db, CONFIG, []);
    expect(await rows("alice", EVENT)).toHaveLength(2);
  });

  it("is a no-op when nothing was applied and recovery is not yet due", async () => {
    // First call completes a pass and stamps the recovery clock to ~now.
    await runGatedFeedPrune(db, CONFIG, []);
    // A fresh over-cap actor is left alone: recovery isn't due and nothing was
    // ingested this call.
    await seed("bob", EVENT, 5);
    await runGatedFeedPrune(db, CONFIG, []);
    expect(await rows("bob", EVENT)).toHaveLength(5);
  });

  it("prunes what real ingestion grew: a fan-out and a follow backfill", async () => {
    // Ingestion only accepts a follow whose subject is a known, valid DID.
    const [alice, bob, carol, erin] = ["did:plc:alice", "did:plc:bob", "did:plc:carol", "did:plc:erin"];
    await runGatedFeedPrune(db, CONFIG, []); // stamp the recovery clock
    // bob posted before anyone followed him.
    await ingestRecords(db, [{ ...applied(bob, EVENT, "create", { name: "x" }), time_us: 8000 }], CONFIG);
    await follow(alice, carol);
    await seed(alice, EVENT, 2); // at cap
    await seed(erin, EVENT, 2); // at cap; follows bob in this batch
    await seed("dave", EVENT, 5); // over cap, untouched by the batch

    // carol's post fans out to alice; erin's follow backfills bob's post.
    const { accepted } = await ingestRecords(
      db,
      [
        applied(carol, EVENT, "create", { name: "y" }),
        { ...applied(erin, FOLLOW, "create", { subject: bob }), time_us: 9001 },
      ],
      CONFIG,
      { knownDids: new Set([bob, erin]) }
    );
    // Ingestion put each of them one over cap.
    expect(await rows(alice, EVENT)).toHaveLength(3);
    expect(await rows(erin, EVENT)).toHaveLength(3);

    await runGatedFeedPrune(db, CONFIG, accepted);
    expect(await rows(alice, EVENT)).toEqual([9000, 1001]);
    expect(await rows(erin, EVENT)).toEqual([8000, 1001]);
    expect(await rows("dave", EVENT)).toHaveLength(5);
  });

  it("prunes only the feeds the batch grew when recovery is not due", async () => {
    await runGatedFeedPrune(db, CONFIG, []); // stamp the recovery clock
    await follow("alice", "bob");
    await seed("alice", EVENT, 5);
    await seed("dave", EVENT, 5);
    await runGatedFeedPrune(db, CONFIG, [applied("bob", EVENT, "create")]);
    expect(await rows("alice", EVENT)).toHaveLength(2);
    expect(await rows("dave", EVENT)).toHaveLength(5); // waits for recovery
  });

  it("falls back to a sweep slice when the fan-out overflows the budget, and recovery drains the rest", async () => {
    await runGatedFeedPrune(db, CONFIG, []); // stamp the recovery clock
    // A bystander first in actor order, so the sweep slice reaches it.
    await seed("a-bystander", EVENT, 5);
    // More followers than the budget (500 actors x 2 capped collections), each
    // one over cap.
    for (let i = 0; i <= 1000; i++) {
      const f = `f-${String(i).padStart(4, "0")}`;
      await follow(f, "bob");
      await seed(f, EVENT, 3);
    }
    await runGatedFeedPrune(db, CONFIG, [applied("bob", EVENT, "create")]);
    expect(await rows("a-bystander", EVENT)).toHaveLength(2);
    // The budget covered 1000 of the 1001 followers.
    expect(await overCapFollowers()).toBeLessThanOrEqual(1);

    // Once recovery is due, the pass reaches whoever the budget left out.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + FEED_PRUNE_RECOVERY_INTERVAL_MS + 1);
    for (let i = 0; i < 4; i++) await runGatedFeedPrune(db, CONFIG, []);
    expect(await overCapFollowers()).toBe(0);
  });
});
