import type { Hono } from "hono";
import type { Database, ContrailConfig, IngestEvent } from "../types";
import { recordsTableName } from "../types";
import { applyEvents } from "../db/records";
import { getPDS } from "../client";
import type { Did } from "@atcute/lexicons";

/** Parse an AT URI into its components. */
export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { did: match[1], collection: match[2], rkey: match[3] };
}

/**
 * Fetch a single record from the user's PDS.
 * Returns the record + cid on success, null if not found.
 */
async function fetchRecordFromPDS(
  pds: string,
  did: string,
  collection: string,
  rkey: string
): Promise<{ value: unknown; cid: string } | null> {
  const url = new URL(`/xrpc/com.atproto.repo.getRecord`, pds);
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", collection);
  url.searchParams.set("rkey", rkey);

  const res = await fetch(url.toString());
  if (!res.ok) return null;

  const data = (await res.json()) as { value?: unknown; cid?: string };
  if (!data.value || !data.cid) return null;
  return { value: data.value, cid: data.cid };
}

export function registerNotifyRoute(
  app: Hono,
  db: Database,
  config: ContrailConfig
) {
  const ns = config.namespace;

  app.post(`/xrpc/${ns}.notifyOfUpdate`, async (c) => {
    const body = await c.req.json<{ uri?: string; uris?: string[] }>().catch(() => null);
    const uris: string[] = [];

    if (body?.uris && Array.isArray(body.uris)) {
      uris.push(...body.uris);
    } else if (body?.uri) {
      uris.push(body.uri);
    } else {
      return c.json({ error: "uri or uris required" }, 400);
    }

    if (uris.length > 25) {
      return c.json({ error: "max 25 URIs per request" }, 400);
    }

    const events: IngestEvent[] = [];
    const errors: string[] = [];

    for (const uri of uris) {
      const parsed = parseAtUri(uri);
      if (!parsed) {
        errors.push(`invalid AT URI: ${uri}`);
        continue;
      }

      // Only accept collections we're tracking
      if (!config.collections[parsed.collection]) {
        errors.push(`collection not tracked: ${parsed.collection}`);
        continue;
      }

      const pds = await getPDS(parsed.did as Did, db);
      if (!pds) {
        errors.push(`could not resolve PDS for ${parsed.did}`);
        continue;
      }

      const result = await fetchRecordFromPDS(
        pds,
        parsed.did,
        parsed.collection,
        parsed.rkey
      );

      const now = Date.now() * 1000; // microseconds

      // Check if this record already exists locally
      const table = recordsTableName(parsed.collection);
      const existing = await db
        .prepare(`SELECT cid FROM ${table} WHERE uri = ?`)
        .bind(uri)
        .first<{ cid: string | null }>();

      if (result) {
        if (existing?.cid === result.cid) {
          // Same CID — nothing changed, skip to avoid double-counting
          continue;
        }

        events.push({
          uri,
          did: parsed.did,
          collection: parsed.collection,
          rkey: parsed.rkey,
          // Both "update" and "create" trigger a full recount of related records.
          operation: existing ? "update" : "create",
          cid: result.cid,
          record: JSON.stringify(result.value),
          time_us: now,
          indexed_at: now,
        });
      } else if (existing) {
        // Record gone from PDS but exists locally — delete it.
        // We need the old record data so buildCountStatements can decrement counts.
        const existingRecord = await db
          .prepare(`SELECT record FROM ${table} WHERE uri = ?`)
          .bind(uri)
          .first<{ record: string | null }>();

        events.push({
          uri,
          did: parsed.did,
          collection: parsed.collection,
          rkey: parsed.rkey,
          operation: "delete",
          cid: null,
          record: existingRecord?.record ?? null,
          time_us: now,
          indexed_at: now,
        });
      }
      // If not on PDS and not local, nothing to do
    }

    if (events.length > 0) {
      await applyEvents(db, events, config);
    }

    return c.json({
      indexed: events.filter((e) => e.operation === "create" || e.operation === "update").length,
      deleted: events.filter((e) => e.operation === "delete").length,
      errors: errors.length > 0 ? errors : undefined,
    });
  });
}
