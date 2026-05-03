import type { Context, Hono } from "hono";
import type {
  ContrailConfig,
  Database,
  FeedConfig,
  FeedTargetConfig,
} from "../types";
import { getDialect } from "../dialect";
import {
  DEFAULT_FOLLOW_SHORT,
  feedTargetMaxItems,
  normalizeFeedTarget,
  recordsTableName,
  shortNameForNsid,
} from "../types";
import { resolveActor } from "../identity";
import { backfillUser } from "../backfill";
import { runPipeline } from "./collection";

const BACKFILL_TIMEOUT_MS = 30_000;
const BACKFILL_REQUEST_TIMEOUT_MS = 10_000;
const BACKFILL_MAX_RETRIES = 3;
/** Re-arm a stuck in-progress row after this long (covers process crashes mid-backfill). */
const BACKFILL_STALE_MS = 5 * 60 * 1000;

interface FeedBackfillStatus {
  completed: number;
  retries: number;
  last_error: string | null;
  started_at: number | null;
}

/** Schedule async work, preferring waitUntil on Cloudflare Workers so the
 *  runtime keeps the request alive until the promise settles. Falls back to
 *  fire-and-forget with a logged catch. */
function scheduleBackground(
  c: Context,
  config: ContrailConfig,
  task: () => Promise<unknown>
): void {
  const log = config.logger ?? console;
  const promise = task().catch((err) =>
    log.error(`[feed] background task failed: ${err}`)
  );
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // No executionCtx (Node/Bun); promise runs detached.
  }
}

/** Run the bootstrap copy + per-target prune. Returns rows inserted. */
async function bootstrapFeedItems(
  db: Database,
  config: ContrailConfig,
  actor: string,
  feedConfig: FeedConfig
): Promise<number> {
  const followShort = feedConfig.follow ?? DEFAULT_FOLLOW_SHORT;
  const followTable = recordsTableName(followShort);
  const targets = feedConfig.targets.map(normalizeFeedTarget);
  let totalInserted = 0;

  for (const target of targets) {
    const targetTable = recordsTableName(target.collection);
    const targetCfg = config.collections[target.collection];
    if (!targetCfg) continue;
    const cap = feedTargetMaxItems(feedConfig, target);

    const insert = await db
      .prepare(
        getDialect(db).insertOrIgnore(
          `INSERT INTO feed_items (actor, uri, collection, time_us)
           SELECT ?, r.uri, ?, r.time_us
           FROM ${targetTable} r
           WHERE r.did IN (
             SELECT ${getDialect(db).jsonExtract("f.record", "subject")}
             FROM ${followTable} f
             WHERE f.did = ?
           )
           ORDER BY r.time_us DESC
           LIMIT ${cap}`
        )
      )
      .bind(actor, targetCfg.collection, actor)
      .run();
    totalInserted += (insert as { changes?: number })?.changes ?? 0;

    // Per-target prune so high-volume targets don't squeeze out lower-volume ones.
    await db
      .prepare(
        `DELETE FROM feed_items WHERE actor = ? AND collection = ? AND uri NOT IN (
           SELECT uri FROM feed_items WHERE actor = ? AND collection = ?
           ORDER BY time_us DESC LIMIT ?
         )`
      )
      .bind(actor, targetCfg.collection, actor, targetCfg.collection, cap)
      .run();
  }

  return totalInserted;
}

/** Run a full backfill cycle: walk follow records → bootstrap feed_items → mark complete.
 *  Updates feed_backfills row with retries/last_error on failure. */
async function runFeedBackfill(
  db: Database,
  config: ContrailConfig,
  actor: string,
  feedName: string,
  feedConfig: FeedConfig
): Promise<void> {
  const followShort = feedConfig.follow ?? DEFAULT_FOLLOW_SHORT;
  const followCfg = config.collections[followShort];
  if (!followCfg) return;

  try {
    const inserted = await backfillUser(
      db,
      actor,
      followCfg.collection,
      Date.now() + BACKFILL_TIMEOUT_MS,
      config,
      {
        skipReplayDetection: true,
        maxRetries: BACKFILL_MAX_RETRIES,
        requestTimeout: BACKFILL_REQUEST_TIMEOUT_MS,
      }
    );

    // Bootstrap from whatever follow records we now have (may be from this
    // backfill, from earlier live ingest, or both).
    await bootstrapFeedItems(db, config, actor, feedConfig);

    // Only mark complete if the underlying follow backfill actually finished
    // (backfills.completed = 1). Avoids the old bug where timeouts/empty
    // walks would lock the user out of any retry.
    const followStatus = await db
      .prepare(
        "SELECT completed FROM backfills WHERE did = ? AND collection = ?"
      )
      .bind(actor, followCfg.collection)
      .first<{ completed: number }>();

    if (followStatus?.completed) {
      await db
        .prepare(
          "UPDATE feed_backfills SET completed = 1, last_error = NULL WHERE actor = ? AND feed = ?"
        )
        .bind(actor, feedName)
        .run();
    } else {
      // Walk didn't complete (timeout/error), but record the partial progress
      // so the next request retries.
      await db
        .prepare(
          "UPDATE feed_backfills SET retries = retries + 1, started_at = NULL, last_error = ? WHERE actor = ? AND feed = ?"
        )
        .bind(
          `follow backfill incomplete (inserted=${inserted})`,
          actor,
          feedName
        )
        .run();
    }
  } catch (err) {
    await db
      .prepare(
        "UPDATE feed_backfills SET retries = retries + 1, started_at = NULL, last_error = ? WHERE actor = ? AND feed = ?"
      )
      .bind(String(err), actor, feedName)
      .run();
  }
}

/** Decide whether to (re)kick off a background backfill, and do so if needed.
 *  Always returns immediately so the request path stays cheap. */
async function maybeBackfillFeed(
  c: Context,
  db: Database,
  config: ContrailConfig,
  actor: string,
  feedName: string,
  feedConfig: FeedConfig
): Promise<void> {
  const status = await db
    .prepare(
      "SELECT completed, retries, last_error, started_at FROM feed_backfills WHERE actor = ? AND feed = ?"
    )
    .bind(actor, feedName)
    .first<FeedBackfillStatus>();

  if (status?.completed) return;

  const now = Date.now();

  // Skip if a backfill is already in flight (started_at recently set) — avoids
  // duplicate work from concurrent requests for the same actor.
  if (status?.started_at && now - status.started_at < BACKFILL_STALE_MS) return;

  // Either no row, or stale started_at. Claim it.
  if (!status) {
    await db
      .prepare(
        "INSERT INTO feed_backfills (actor, feed, completed, started_at) VALUES (?, ?, 0, ?) ON CONFLICT DO NOTHING"
      )
      .bind(actor, feedName, now)
      .run();
  } else {
    await db
      .prepare(
        "UPDATE feed_backfills SET started_at = ? WHERE actor = ? AND feed = ?"
      )
      .bind(now, actor, feedName)
      .run();
  }

  scheduleBackground(c, config, () =>
    runFeedBackfill(db, config, actor, feedName, feedConfig)
  );
}

export function registerFeedRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig
): void {
  if (!config.feeds) return;

  const ns = config.namespace;

  app.get(`/xrpc/${ns}.getFeed`, async (c) => {
    const params = new URL(c.req.url).searchParams;
    const feedName = params.get("feed");
    const actor = params.get("actor");

    if (!feedName || !actor) {
      return c.json({ error: "feed and actor parameters required" }, 400);
    }

    const feedConfig = config.feeds![feedName];
    if (!feedConfig) {
      return c.json({ error: "Unknown feed" }, 404);
    }

    const did = await resolveActor(db, actor);
    if (!did) return c.json({ error: "Could not resolve actor" }, 400);

    await maybeBackfillFeed(c, db, config, did, feedName, feedConfig);

    const targets = feedConfig.targets.map(normalizeFeedTarget);
    if (targets.length === 0) {
      return c.json({ error: "Feed has no targets configured" }, 500);
    }
    // Wire-level `collection` is an NSID (matches the generated lex enum and
    // what's stored in feed_items.collection). Internally runPipeline expects
    // the short name, so translate.
    const requestedRaw = params.get("collection");
    let requestedShort: string;
    if (!requestedRaw) {
      requestedShort = targets[0].collection;
    } else if (targets.some((t) => t.collection === requestedRaw)) {
      // Tolerate callers passing the short name directly.
      requestedShort = requestedRaw;
    } else {
      const asShort = shortNameForNsid(config, requestedRaw);
      if (asShort && targets.some((t) => t.collection === asShort)) {
        requestedShort = asShort;
      } else {
        return c.json({ error: "Collection not in feed targets" }, 400);
      }
    }

    // Strip feed-specific params so runPipeline doesn't misinterpret them
    // (e.g. "actor" in feeds means "whose feed", not "filter by record creator")
    const pipelineParams = new URLSearchParams(params);
    pipelineParams.delete("feed");
    pipelineParams.delete("actor");
    pipelineParams.delete("collection");

    const source = {
      joins: "JOIN feed_items f ON r.uri = f.uri",
      conditions: ["f.actor = ?"],
      params: [did],
    };

    try {
      const result = await runPipeline(db, config, requestedShort, pipelineParams, source);
      return c.json(result);
    } catch (e: any) {
      if (e.message === "Could not resolve actor") {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }
  });
}

export type { FeedTargetConfig };
