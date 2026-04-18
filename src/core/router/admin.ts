import type { Hono } from "hono";
import type { ContrailConfig, Database } from "../types";
import { getCollectionShortNames, recordsTableName, nsidForShortName } from "../types";
import { getLastCursor } from "../db";

export function registerAdminRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig
): void {
  const ns = config.namespace;

  app.get(`/xrpc/${ns}.getCursor`, async (c) => {
    const cursor = await getLastCursor(db);
    if (cursor === null) return c.json({ cursor: null });

    const dateMs = Math.floor(cursor / 1000);
    return c.json({
      time_us: cursor,
      date: new Date(dateMs).toISOString(),
      seconds_ago: Math.floor((Date.now() - dateMs) / 1000),
    });
  });

  app.get(`/xrpc/${ns}.getOverview`, async (c) => {
    const collections: { collection: string; records: number; unique_users: number }[] = [];

    for (const short of getCollectionShortNames(config)) {
      const table = recordsTableName(short);
      const nsid = nsidForShortName(config, short) ?? short;
      const row = await db
        .prepare(`SELECT COUNT(*) as records, COUNT(DISTINCT did) as unique_users FROM ${table}`)
        .first<{ records: number; unique_users: number }>();
      if (row) {
        collections.push({ collection: nsid, records: row.records, unique_users: row.unique_users });
      }
    }

    return c.json({
      total_records: collections.reduce((sum, col) => sum + col.records, 0),
      collections,
    });
  });
}
