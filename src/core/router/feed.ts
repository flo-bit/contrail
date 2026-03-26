import type { Hono } from "hono";
import type { ContrailConfig, Database, FeedConfig } from "../types";
import { getDialect } from "../dialect";
import { DEFAULT_FEED_MAX_ITEMS, recordsTableName } from "../types";
import { resolveActor } from "../identity";
import { backfillUser } from "../backfill";
import { runPipeline } from "./collection";

async function maybeBackfillFeed(
  db: Database,
  config: ContrailConfig,
  actor: string,
  feedName: string,
  feedConfig: FeedConfig
): Promise<void> {
  const status = await db
    .prepare("SELECT completed FROM feed_backfills WHERE actor = ? AND feed = ?")
    .bind(actor, feedName)
    .first<{ completed: number }>();

  if (status?.completed) return;

  // Ensure the user's follow records are backfilled first
  await backfillUser(db, actor, feedConfig.follow, Date.now() + 15_000, config);

  // Mark as in-progress (idempotent)
  await db
    .prepare(
      "INSERT INTO feed_backfills (actor, feed, completed) VALUES (?, ?, 0) ON CONFLICT DO NOTHING"
    )
    .bind(actor, feedName)
    .run();

  const maxItems = feedConfig.maxItems ?? DEFAULT_FEED_MAX_ITEMS;

  // Populate feed from existing records by followed users
  const followTable = recordsTableName(feedConfig.follow);
  for (const targetCol of feedConfig.targets) {
    const targetTable = recordsTableName(targetCol);
    await db
      .prepare(
        getDialect(db).insertOrIgnore(
          `INSERT INTO feed_items (actor, uri, collection, time_us)
         SELECT ?, r.uri, ?, r.time_us
         FROM ${targetTable} r
         WHERE r.did IN (
             SELECT ${getDialect(db).jsonExtract('f.record', 'subject')}
             FROM ${followTable} f
             WHERE f.did = ?
           )
         ORDER BY r.time_us DESC
         LIMIT ?`
        )
      )
      .bind(actor, targetCol, actor, maxItems)
      .run();
  }

  // Prune oldest items beyond the cap
  await db
    .prepare(
      `DELETE FROM feed_items WHERE actor = ? AND uri NOT IN (
         SELECT uri FROM feed_items WHERE actor = ? ORDER BY time_us DESC LIMIT ?
       )`
    )
    .bind(actor, actor, maxItems)
    .run();

  await db
    .prepare("UPDATE feed_backfills SET completed = 1 WHERE actor = ? AND feed = ?")
    .bind(actor, feedName)
    .run();
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

    await maybeBackfillFeed(db, config, did, feedName, feedConfig);

    const collection = params.get("collection") || feedConfig.targets[0];
    if (!feedConfig.targets.includes(collection)) {
      return c.json({ error: "Collection not in feed targets" }, 400);
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
      const result = await runPipeline(db, config, collection, pipelineParams, source);
      return c.json(result);
    } catch (e: any) {
      if (e.message === "Could not resolve actor") {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }
  });
}
