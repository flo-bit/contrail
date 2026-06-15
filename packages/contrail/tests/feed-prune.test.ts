import { describe, it, expect, beforeEach } from "vitest";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import type { Database, ResolvedContrailConfig } from "../src/core/types";
import { resolveConfig } from "../src/core/types";
import { initSchema } from "../src/core/db/schema";
import {
  pruneActorFeed,
  sweepFeedItems,
  pruneFeedItems,
  getFeedPruneCursor,
  saveFeedPruneCursor,
} from "../src/core/db/records";
import { runGatedFeedPrune } from "../src/core/jetstream";

const EVENT = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";

// Feeds config: event capped at 2 per actor, rsvp at 3. resolveConfig
// auto-adds the `follow` collection, so initSchema builds feed_items, the
// idx_feed_actor_coll_time index, and feed_prune_cursor.
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

beforeEach(async () => {
  db = createSqliteDatabase(":memory:");
  await initSchema(db, CONFIG);
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

describe("runGatedFeedPrune (recovery gate)", () => {
  it("sweeps when a full pass is overdue, even with feedTouched=false", async () => {
    // The persisted recovery clock is unset (0), so a pass is overdue. This is
    // the path a no-op notify call or an idle stream relies on to make progress.
    await seed("alice", EVENT, 5); // cap 2
    await runGatedFeedPrune(db, CONFIG, false);
    expect(await rows("alice", EVENT)).toHaveLength(2);
  });

  it("is a no-op when not feed-touched and recovery is not yet due", async () => {
    // First call completes a pass and stamps the recovery clock to ~now.
    await runGatedFeedPrune(db, CONFIG, false);
    // A fresh over-cap actor is left alone: recovery isn't due and nothing was
    // ingested this call.
    await seed("bob", EVENT, 5);
    await runGatedFeedPrune(db, CONFIG, false);
    expect(await rows("bob", EVENT)).toHaveLength(5);
  });

  it("sweeps on feedTouched even when recovery is not due", async () => {
    await runGatedFeedPrune(db, CONFIG, false); // stamp the recovery clock
    await seed("bob", EVENT, 5);
    await runGatedFeedPrune(db, CONFIG, true);
    expect(await rows("bob", EVENT)).toHaveLength(2);
  });
});
