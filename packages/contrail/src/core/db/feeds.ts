import type {
  ContrailConfig,
  Database,
  IngestEvent,
  Statement,
} from "../types";
import {
  DEFAULT_FOLLOW_SHORT,
  buildFeedTargetCaps,
  feedTargetMaxItems,
  normalizeFeedTarget,
  nsidForShortName,
  recordsTableName,
  shortNameForNsid,
} from "../types";
import { getDialect } from "../dialect";

export function buildFeedStatements(
  db: Database,
  event: IngestEvent,
  config: ContrailConfig,
  existingRecords: Map<string, string | null>,
  parsedRecord?: unknown,
): Statement[] {
  if (!config.feeds) return [];

  const stmts: Statement[] = [];

  const eventShort = shortNameForNsid(config, event.collection);
  if (!eventShort) return [];

  for (const [, feedConfig] of Object.entries(config.feeds)) {
    const followShort = feedConfig.follow ?? DEFAULT_FOLLOW_SHORT;
    const followTable = recordsTableName(followShort);
    const targets = feedConfig.targets.map(normalizeFeedTarget);
    const targetShorts = targets.map((t) => t.collection);

    // Target collection: fan out to followers
    if (targetShorts.includes(eventShort)) {
      if (event.operation === "create" || event.operation === "update") {
        stmts.push(
          db
            .prepare(
              getDialect(db).insertOrIgnore(
                `INSERT INTO feed_items (actor, uri, collection, time_us)
               SELECT r.did, ?, ?, ?
               FROM ${followTable} r
               WHERE ${getDialect(db).jsonExtract("r.record", "subject")} = ?`,
              ),
            )
            .bind(event.uri, event.collection, event.time_us, event.did),
        );
      } else if (event.operation === "delete") {
        stmts.push(
          db.prepare("DELETE FROM feed_items WHERE uri = ?").bind(event.uri),
        );
      }
    }

    // Follow collection: handle follow/unfollow
    if (eventShort === followShort) {
      if (event.operation === "create") {
        const record =
          parsedRecord !== undefined
            ? parsedRecord
            : event.record
              ? JSON.parse(event.record)
              : null;
        const subject = (record as { subject?: unknown } | null)?.subject;
        if (subject) {
          for (const target of targets) {
            const targetTable = recordsTableName(target.collection);
            const targetNsid =
              nsidForShortName(config, target.collection) ?? target.collection;
            const cap = feedTargetMaxItems(feedConfig, target);
            stmts.push(
              db
                .prepare(
                  getDialect(db).insertOrIgnore(
                    `INSERT INTO feed_items (actor, uri, collection, time_us)
                   SELECT ?, r.uri, ?, r.time_us
                   FROM ${targetTable} r
                   WHERE r.did = ?
                   ORDER BY r.time_us DESC
                   LIMIT ${cap}`,
                  ),
                )
                .bind(event.did, targetNsid, subject),
            );
          }
        }
      } else if (event.operation === "delete") {
        const existingRecord = existingRecords.get(event.uri);
        if (existingRecord) {
          const parsed = JSON.parse(existingRecord);
          const subject = parsed?.subject;
          if (subject) {
            for (const target of targets) {
              const targetTable = recordsTableName(target.collection);
              stmts.push(
                db
                  .prepare(
                    `DELETE FROM feed_items WHERE actor = ? AND uri IN (
                       SELECT uri FROM ${targetTable} WHERE did = ?
                     )`,
                  )
                  .bind(event.did, subject),
              );
            }
          }
        }
      }
    }
  }

  return stmts;
}

// --- Feed pruning ---

/** db.batch chunk size for the sweep — caps statements per transaction. */
const SWEEP_BATCH_SIZE = 50;
/** Actor page size for the full-table {@link pruneFeedItems} recovery loop. */
const FEED_PRUNE_RECOVERY_BATCH = 200;

/**
 * Build the bounded per-actor cutoff DELETE for one (actor, collection).
 *
 * Deletes everything older than the newest `cap` rows, driven directly by
 * idx_feed_actor_coll_time(actor, collection, time_us DESC). Cost is
 * O(cap + deleted) — never O(table). This is the ONLY prune shape contrail
 * issues: an unbounded window/anti-join over the whole table can exhaust D1's
 * per-query CPU budget and reset the shared Durable Object, which kills any
 * concurrent read against the same SQLite instance.
 *
 * The cutoff is the cap-th newest row (`OFFSET cap - 1`); we delete strictly
 * older rows. Actors with `cap` or fewer rows: the OFFSET subquery yields no
 * row, the cutoff is NULL, and `time_us < NULL` matches nothing — a cheap
 * index no-op. On a tie at the cutoff time_us we keep the extra rows rather
 * than risk deleting a row we meant to keep (feed_items is a cache; a few over
 * cap is harmless, dropping a wanted item is not).
 */
function actorCutoffDelete(
  db: Database,
  actor: string,
  collection: string,
  cap: number,
): Statement {
  // Plain `?` placeholders (bound repeatedly) rather than numbered params, so
  // the Postgres adapter's positional `?`→`$n` rewrite stays correct.
  return db
    .prepare(
      `DELETE FROM feed_items
         WHERE actor = ? AND collection = ?
           AND time_us < (
             SELECT time_us FROM feed_items
             WHERE actor = ? AND collection = ?
             ORDER BY time_us DESC LIMIT 1 OFFSET ?
           )`,
    )
    .bind(actor, collection, actor, collection, Math.max(0, cap - 1));
}

/** Prune a single actor's feed for one collection to `cap`. Bounded O(cap). */
export async function pruneActorFeed(
  db: Database,
  actor: string,
  collection: string,
  cap: number,
): Promise<number> {
  const result = await actorCutoffDelete(db, actor, collection, cap).run();
  return (result as any)?.changes ?? 0;
}

export interface FeedSweepResult {
  /** Rows deleted this slice. */
  pruned: number;
  /** Actor to resume after; null once a full pass completed (wrap to start). */
  nextCursor: string | null;
  /** True when this slice reached the end of the actor list. */
  done: boolean;
}

/**
 * One bounded slice of a rolling feed-items prune.
 *
 * Pages at most `actorBudget` distinct actors (resuming after `cursor`, via the
 * feed_items (actor, uri) PK) and applies the per-(actor, collection) cutoff
 * delete for every cap in `caps`. Every issued statement is index-backed and
 * O(cap), so the slice's per-query CPU stays flat no matter how large
 * feed_items grows — the property the old global window query lacked.
 *
 * Drive it across ticks with a persisted cursor (see getFeedPruneCursor):
 * feed back `nextCursor` until `done`, at which point the cursor wraps to null
 * and the next pass starts from the beginning. Because each pass visits every
 * actor, this doubles as the recovery path for an already-bloated table.
 */
export async function sweepFeedItems(
  db: Database,
  caps: Map<string, number>,
  cursor: string | null,
  actorBudget: number,
): Promise<FeedSweepResult> {
  if (caps.size === 0 || actorBudget <= 0) {
    return { pruned: 0, nextCursor: null, done: true };
  }

  const actorsRes = cursor
    ? await db
        .prepare(
          "SELECT DISTINCT actor FROM feed_items WHERE actor > ? ORDER BY actor LIMIT ?",
        )
        .bind(cursor, actorBudget)
        .all<{ actor: string }>()
    : await db
        .prepare("SELECT DISTINCT actor FROM feed_items ORDER BY actor LIMIT ?")
        .bind(actorBudget)
        .all<{ actor: string }>();

  const actors = (actorsRes.results ?? []).map((r) => r.actor);
  if (actors.length === 0) {
    // Ran off the end (cursor pointed past the last actor) — wrap next tick.
    return { pruned: 0, nextCursor: null, done: true };
  }

  const stmts: Statement[] = [];
  for (const actor of actors) {
    for (const [collection, cap] of caps) {
      stmts.push(actorCutoffDelete(db, actor, collection, cap));
    }
  }

  let pruned = 0;
  for (let i = 0; i < stmts.length; i += SWEEP_BATCH_SIZE) {
    const results = await db.batch(stmts.slice(i, i + SWEEP_BATCH_SIZE));
    for (const r of results) pruned += (r as any)?.changes ?? 0;
  }

  // A short page means we exhausted the actor list this slice.
  const done = actors.length < actorBudget;
  return { pruned, nextCursor: done ? null : actors[actors.length - 1], done };
}

/**
 * Prune the ENTIRE feed_items table to the per-collection `caps` by looping the
 * bounded {@link sweepFeedItems} until a full pass completes.
 *
 * Every statement is O(cap) and safe against D1's per-query CPU limit, but the
 * statement count is O(distinct actors), so keep this OFF the hot ingest path —
 * the cron/persistent loops issue a single bounded slice per tick instead. Use
 * it for one-shot recovery or admin tooling.
 */
export async function pruneFeedItems(
  db: Database,
  caps: Map<string, number>,
): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  for (;;) {
    const res = await sweepFeedItems(
      db,
      caps,
      cursor,
      FEED_PRUNE_RECOVERY_BATCH,
    );
    total += res.pruned;
    if (res.done) break;
    cursor = res.nextCursor;
  }
  return total;
}

/** Subjects per follower lookup in {@link pruneGrownFeeds}, under D1's limit of
 *  100 bound parameters per statement. */
const GROWN_FEED_SUBJECT_CHUNK = 50;

export interface GrownFeedPruneResult {
  /** Rows deleted. */
  pruned: number;
  /** True when the batch grew more than `limit` feeds. Only `limit` of them were
   *  pruned; the caller should fall back to the rolling sweep. */
  overflow: boolean;
}

/**
 * Prune only the feeds an applied ingest batch can have grown.
 *
 * A feed grows only through the two inserts in buildFeedStatements: a target
 * create/update fans out to the author's followers, and a follow create
 * backfills the subject's recent items into the follower's feed. Deletes only
 * shrink feeds. So this looks up the followers of the batch's target authors,
 * adds the batch's new followers, and runs the cutoff delete for those
 * (actor, collection) pairs only, rather than for a slice of every actor.
 *
 * A follow update counts as a new follower too. The cron path applies a batch
 * in several transactions and prunes once at the end, so a fan-out to a
 * follower can precede an update that repoints their follow; the lookup by
 * subject would then no longer find them.
 *
 * A popular author's fan-out has no upper bound, so at most `limit` feeds are
 * pruned and `overflow` reports the rest. feed_items is a soft cache, so a feed
 * left a few rows over cap until the sweep reaches it is harmless.
 */
export async function pruneGrownFeeds(
  db: Database,
  config: ContrailConfig,
  events: readonly IngestEvent[],
  limit: number,
): Promise<GrownFeedPruneResult> {
  const caps = buildFeedTargetCaps(config);
  if (!config.feeds || caps.size === 0 || limit <= 0) {
    return { pruned: 0, overflow: false };
  }

  const grown = new Map<string, { actor: string; collection: string }>();
  const add = (actor: string, collection: string) => {
    if (caps.has(collection)) {
      grown.set(`${actor}\0${collection}`, { actor, collection });
    }
  };
  let overflow = false;

  for (const feedConfig of Object.values(config.feeds)) {
    const followShort = feedConfig.follow ?? DEFAULT_FOLLOW_SHORT;
    const targets = feedConfig.targets.map(normalizeFeedTarget);
    const targetShorts = targets.map((t) => t.collection);
    // Target authors in this batch -> the collections they wrote to.
    const authors = new Map<string, Set<string>>();

    for (const e of events) {
      const short = shortNameForNsid(config, e.collection);
      if (!short) continue;
      if (
        targetShorts.includes(short) &&
        (e.operation === "create" || e.operation === "update")
      ) {
        const written = authors.get(e.did) ?? new Set<string>();
        written.add(e.collection);
        authors.set(e.did, written);
      }
      if (
        short === followShort &&
        (e.operation === "create" || e.operation === "update")
      ) {
        for (const target of targets) {
          add(
            e.did,
            nsidForShortName(config, target.collection) ?? target.collection,
          );
        }
      }
    }

    const subjectExpr = getDialect(db).jsonExtract("r.record", "subject");
    const subjects = [...authors.keys()];
    for (
      let i = 0;
      i < subjects.length && !overflow;
      i += GROWN_FEED_SUBJECT_CHUNK
    ) {
      const chunk = subjects.slice(i, i + GROWN_FEED_SUBJECT_CHUNK);
      const res = await db
        .prepare(
          `SELECT r.did AS actor, ${subjectExpr} AS subject
           FROM ${recordsTableName(followShort)} r
           WHERE ${subjectExpr} IN (${chunk.map(() => "?").join(", ")})
           LIMIT ?`,
        )
        .bind(...chunk, limit + 1)
        .all<{ actor: string; subject: string }>();
      const followers = res.results ?? [];
      for (const row of followers) {
        for (const collection of authors.get(row.subject) ?? []) {
          add(row.actor, collection);
        }
      }
      if (followers.length > limit) overflow = true;
    }
    if (grown.size > limit) overflow = true;
  }

  const stmts = [...grown.values()]
    .slice(0, limit)
    .map(({ actor, collection }) =>
      actorCutoffDelete(db, actor, collection, caps.get(collection)!),
    );
  let pruned = 0;
  for (let i = 0; i < stmts.length; i += SWEEP_BATCH_SIZE) {
    const results = await db.batch(stmts.slice(i, i + SWEEP_BATCH_SIZE));
    for (const r of results) pruned += (r as any)?.changes ?? 0;
  }
  return { pruned, overflow };
}

// --- Feed prune cursor ---

/** Last actor swept by the rolling feed prune; null = start of a fresh pass. */
export async function getFeedPruneCursor(db: Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT actor FROM feed_prune_cursor WHERE id = 1")
    .first<{ actor: string | null }>();
  return row?.actor ?? null;
}

export async function saveFeedPruneCursor(
  db: Database,
  actor: string | null,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO feed_prune_cursor (id, actor) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET actor = excluded.actor",
    )
    .bind(actor)
    .run();
}
