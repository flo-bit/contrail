import type { Hono, Context, Next } from "hono";
import type { ContrailConfig, Database } from "../types";
import { getLastCursor } from "../db";
import { initSchema } from "../db/schema";

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

  app.get(`/xrpc/${ns}.admin.reset`, requireAdmin, async (c) => {
    const tables = ["records", "backfills", "discovery", "cursor", "identities"];
    await db.batch(tables.map((t) => db.prepare(`DELETE FROM ${t}`)));
    return c.json({ ok: true });
  });
}
