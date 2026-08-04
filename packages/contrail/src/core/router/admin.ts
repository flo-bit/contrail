import type { Hono } from "hono";
import type { ContrailConfig, Database } from "../types";
import { getCollectionShortNames, recordsTableName, nsidForShortName } from "../types";
import { getLastCursor } from "../db";
import { getBackfillStatus } from "../status";

export interface CursorStatus {
  cursor: number | null;
  date: string | null;
  seconds_ago: number | null;
}

export interface CollectionOverview {
  collection: string;
  records: number;
  unique_users: number;
}

export async function getCursorStatus(db: Database): Promise<CursorStatus> {
  const cursor = await getLastCursor(db);
  if (cursor === null) {
    return { cursor: null, date: null, seconds_ago: null };
  }

  const dateMs = Math.floor(cursor / 1000);
  return {
    cursor,
    date: new Date(dateMs).toISOString(),
    seconds_ago: Math.max(0, Math.floor((Date.now() - dateMs) / 1000)),
  };
}

export async function getOverview(db: Database, config: ContrailConfig) {
  const collections: CollectionOverview[] = [];

  for (const short of getCollectionShortNames(config)) {
    const table = recordsTableName(short);
    const nsid = nsidForShortName(config, short) ?? short;
    const row = await db
      .prepare(`SELECT COUNT(*) as records, COUNT(DISTINCT did) as unique_users FROM ${table}`)
      .first<{ records: number; unique_users: number }>();
    if (row) {
      collections.push({
        collection: nsid,
        records: Number(row.records),
        unique_users: Number(row.unique_users),
      });
    }
  }

  const [ingestion, backfill] = await Promise.all([
    getCursorStatus(db),
    getBackfillStatus(db, config),
  ]);

  return {
    status: "ok" as const,
    total_records: collections.reduce((sum, col) => sum + col.records, 0),
    collections,
    ingestion,
    backfill,
  };
}

export function registerAdminRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig
): void {
  const ns = config.namespace;

  app.get(`/xrpc/${ns}.getCursor`, async (c) => {
    const cursor = await getCursorStatus(db);
    if (cursor.cursor === null) return c.json({ cursor: null });
    return c.json({
      time_us: cursor.cursor,
      date: cursor.date,
      seconds_ago: cursor.seconds_ago,
    });
  });

  app.get(`/xrpc/${ns}.getOverview`, async (c) =>
    c.json(await getOverview(db, config))
  );
}
