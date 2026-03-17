import type { Hono, Context, Next } from "hono";
import type { ContrailConfig, Database } from "../types";
import { getCollectionNames } from "../types";
import { getLastCursor } from "../db";
import { backfillUser, discoverDIDs } from "../backfill";
import { parseIntParam } from "./helpers";

export function registerAdminRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig,
  adminSecret?: string
): void {
  const requireAdmin = async (c: Context, next: Next) => {
    if (adminSecret) {
      const auth = c.req.header("Authorization");
      if (auth !== `Bearer ${adminSecret}`)
        return c.json({ error: "Unauthorized" }, 401);
    } else {
      const url = new URL(c.req.url);
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
        return c.json({ error: "ADMIN_SECRET not configured" }, 403);
    }
    await next();
  };

  const ns = config.namespace;

  app.get(`/xrpc/${ns}.admin.getCursor`, async (c) => {
    const cursor = await getLastCursor(db);
    if (cursor === null) return c.json({ cursor: null });

    const dateMs = Math.floor(cursor / 1000);
    return c.json({
      time_us: cursor,
      date: new Date(dateMs).toISOString(),
      seconds_ago: Math.floor((Date.now() - dateMs) / 1000),
    });
  });

  app.get(`/xrpc/${ns}.admin.getOverview`, async (c) => {
    const result = await db
      .prepare(
        "SELECT collection, COUNT(*) as records, COUNT(DISTINCT did) as unique_users FROM records GROUP BY collection"
      )
      .all<{ collection: string; records: number; unique_users: number }>();

    const collections = result.results ?? [];
    return c.json({
      total_records: collections.reduce((sum, col) => sum + col.records, 0),
      collections,
    });
  });

  app.get(`/xrpc/${ns}.admin.sync`, requireAdmin, async (c) => {
    const deadline = Date.now() + 25_000;
    const concurrency = parseIntParam(c.req.query("concurrency"), 25) ?? 25;

    // Phase 1: Discover DIDs from relays
    const dids = await discoverDIDs(db, config, deadline);

    const discoverableCount = getCollectionNames(config).filter(
      (col) => config.collections[col]?.discover !== false
    ).length;
    const discoveryRows = await db
      .prepare("SELECT COUNT(*) as count FROM discovery")
      .first<{ count: number }>();
    const pendingDiscovery = await db
      .prepare("SELECT COUNT(*) as count FROM discovery WHERE completed = 0")
      .first<{ count: number }>();
    const discoveryDone =
      (discoveryRows?.count ?? 0) >= discoverableCount &&
      (pendingDiscovery?.count ?? 0) === 0;

    // Ensure dependent collections have backfill entries for all known DIDs
    const dependentCollections = getCollectionNames(config).filter(
      (col) => config.collections[col]?.discover === false
    );
    if (dependentCollections.length > 0 && Date.now() < deadline) {
      for (const depCol of dependentCollections) {
        await db
          .prepare(
            `INSERT OR IGNORE INTO backfills (did, collection, completed)
             SELECT DISTINCT r.did, ?, 0 FROM records r
             LEFT JOIN backfills b ON b.did = r.did AND b.collection = ?
             WHERE b.did IS NULL`
          )
          .bind(depCol, depCol)
          .run();
      }
    }

    // Phase 2: Backfill records from PDS
    let backfilled = 0;
    if (Date.now() < deadline) {
      const pending = await db
        .prepare(
          "SELECT did, collection FROM backfills WHERE completed = 0 LIMIT 500"
        )
        .all<{ did: string; collection: string }>();

      const rows = pending.results ?? [];
      for (let i = 0; i < rows.length; i += concurrency) {
        if (Date.now() >= deadline) break;
        const batch = rows.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map((row) =>
            backfillUser(db, row.did, row.collection, deadline, config)
          )
        );
        for (const r of results) {
          if (r.status === "fulfilled") backfilled += r.value;
        }
      }
    }

    const remaining = await db
      .prepare("SELECT COUNT(*) as count FROM backfills WHERE completed = 0")
      .first<{ count: number }>();

    return c.json({
      discovered: dids.length,
      backfilled,
      remaining: remaining?.count ?? 0,
      done: discoveryDone && (remaining?.count ?? 0) === 0,
    });
  });

  app.get(`/xrpc/${ns}.admin.reset`, requireAdmin, async (c) => {
    const tables = ["records", "counts", "backfills", "discovery", "cursor", "identities"];
    await db.batch(tables.map((t) => db.prepare(`DELETE FROM ${t}`)));
    return c.json({ ok: true });
  });
}
