import type { Hono } from "hono";
import type { Database, ContrailConfig, IngestEvent } from "../types";
import { shortNameForNsid } from "../types";
import { applyEvents, lookupExistingRecords } from "../db/records";
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

export interface NotifyResult {
  indexed: number;
  deleted: number;
  errors?: string[];
}

/**
 * Process notify URIs: fetch from PDS, detect changes, apply events.
 * Shared by both the Hono route and the Contrail.notify() method.
 */
export async function processNotifyUris(
  db: Database,
  config: ContrailConfig,
  uris: string[]
): Promise<NotifyResult> {
  const events: IngestEvent[] = [];
  const errors: string[] = [];

  // Validate and parse all URIs first
  const validUris: { uri: string; parsed: { did: string; collection: string; rkey: string } }[] = [];
  for (const uri of uris) {
    const parsed = parseAtUri(uri);
    if (!parsed) {
      errors.push(`invalid AT URI: ${uri}`);
      continue;
    }
    // `parsed.collection` is an NSID; look up the matching short name.
    if (!shortNameForNsid(config, parsed.collection)) {
      errors.push(`collection not tracked: ${parsed.collection}`);
      continue;
    }
    validUris.push({ uri, parsed });
  }

  // Single batch lookup for all existing records (cid + record in one query)
  const existing = await lookupExistingRecords(
    db,
    validUris.map(({ uri, parsed }) => ({ uri, collection: parsed.collection })),
    true,
    config
  );

  for (const { uri, parsed } of validUris) {
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
    const existingInfo = existing.get(uri);

    if (result) {
      if (existingInfo?.cid === result.cid) {
        // Same CID — nothing changed
        continue;
      }

      events.push({
        uri,
        did: parsed.did,
        collection: parsed.collection,
        rkey: parsed.rkey,
        operation: existingInfo ? "update" : "create",
        cid: result.cid,
        record: JSON.stringify(result.value),
        time_us: now,
        indexed_at: now,
      });
    } else if (existingInfo) {
      // Record gone from PDS but exists locally — delete it.
      events.push({
        uri,
        did: parsed.did,
        collection: parsed.collection,
        rkey: parsed.rkey,
        operation: "delete",
        cid: null,
        record: existingInfo.record,
        time_us: now,
        indexed_at: now,
      });
    }
  }

  if (events.length > 0) {
    // Pass pre-fetched existing records so applyEvents skips re-querying
    await applyEvents(db, events, config, { existing });
  }

  return {
    indexed: events.filter((e) => e.operation === "create" || e.operation === "update").length,
    deleted: events.filter((e) => e.operation === "delete").length,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export function registerNotifyRoute(
  app: Hono,
  db: Database,
  config: ContrailConfig
) {
  // Endpoint is off by default. Set config.notify to true or a secret string to enable.
  if (!config.notify) return;

  const ns = config.namespace;
  const secret = typeof config.notify === "string" ? config.notify : null;

  app.post(`/xrpc/${ns}.notifyOfUpdate`, async (c) => {
    if (secret) {
      const auth = c.req.header("Authorization");
      if (auth !== `Bearer ${secret}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }

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

    const result = await processNotifyUris(db, config, uris);
    return c.json(result);
  });
}
