import type { Hono } from "hono";
import type { Database, ContrailConfig, IngestEvent } from "../types";
import { shortNameForNsid, getFeedMutatingNsids } from "../types";
import { lookupExistingRecords } from "../db/records";
import { createIngestEvent, ingestRecords } from "../ingest";
import { runGatedFeedPrune } from "../jetstream";
import { getPDS } from "../client";
import type { Did } from "@atcute/lexicons";
import { parseCanonicalResourceUri } from "@atcute/lexicons/syntax";

/** Parse a canonical (DID-authority) record AT-URI into its components, or null
 *  if it isn't a valid full record URI. Backed by atcute's validator, which
 *  also enforces the DID / NSID / record-key character classes. */
export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const parsed = parseCanonicalResourceUri(uri);
  if (!parsed.ok) return null;
  const { repo, collection, rkey } = parsed.value;
  return { did: repo, collection, rkey };
}

const NOTIFY_FETCH_TIMEOUT_MS = 5_000;

type RecordFetchResult =
  | { kind: "found"; value: Record<string, unknown>; cid: string }
  | { kind: "not-found" }
  | { kind: "error"; status?: number; message: string };

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/** Fetch one authoritative record without conflating failure with deletion. */
async function fetchRecordFromPDS(
  pds: string,
  did: string,
  collection: string,
  rkey: string,
  signal: AbortSignal,
): Promise<RecordFetchResult> {
  const url = new URL(`/xrpc/com.atproto.repo.getRecord`, pds);
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", collection);
  url.searchParams.set("rkey", rkey);

  let response: Response;
  try {
    response = await fetch(url.toString(), { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return { kind: "error", message: `network failure: ${String(error)}` };
  }

  if (!response.ok) {
    const body = await response.json().catch((error) => {
      if (signal.aborted) throw error;
      return null;
    }) as { error?: unknown; message?: unknown } | null;
    const errorCode = typeof body?.error === "string" ? body.error : undefined;
    if (errorCode === "RecordNotFound") {
      return { kind: "not-found" };
    }
    const detail =
      errorCode ??
      (typeof body?.message === "string" ? body.message : response.statusText);
    return {
      kind: "error",
      status: response.status,
      message: `PDS returned ${response.status}${detail ? ` (${detail})` : ""}`,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      kind: "error",
      status: response.status,
      message: `malformed JSON response: ${String(error)}`,
    };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      kind: "error",
      status: response.status,
      message: "malformed record response",
    };
  }
  const { value, cid } = data as { value?: unknown; cid?: unknown };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof cid !== "string" ||
    cid.length === 0
  ) {
    return {
      kind: "error",
      status: response.status,
      message: "malformed record response",
    };
  }
  return {
    kind: "found",
    value: value as Record<string, unknown>,
    cid,
  };
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
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("notify deadline exceeded")),
      NOTIFY_FETCH_TIMEOUT_MS,
    );
    let result: RecordFetchResult;
    try {
      const pds = await abortable(
        getPDS(parsed.did as Did, db, config),
        controller.signal,
      );
      if (!pds) {
        errors.push(`${uri}: could not resolve PDS for ${parsed.did}`);
        continue;
      }
      result = await abortable(
        fetchRecordFromPDS(
          pds,
          parsed.did,
          parsed.collection,
          parsed.rkey,
          controller.signal,
        ),
        controller.signal,
      );
    } catch (error) {
      errors.push(
        controller.signal.aborted
          ? `${uri}: PDS request timed out after ${NOTIFY_FETCH_TIMEOUT_MS}ms`
          : `${uri}: could not resolve or fetch from PDS: ${String(error)}`,
      );
      continue;
    } finally {
      clearTimeout(timeout);
    }

    const existingInfo = existing.get(uri);
    if (result.kind === "error") {
      errors.push(`${uri}: ${result.message}`);
      continue;
    }

    const now = Date.now() * 1000;
    if (result.kind === "found") {
      if (existingInfo?.cid === result.cid) continue;
      events.push(
        createIngestEvent({
          uri,
          did: parsed.did,
          collection: parsed.collection,
          rkey: parsed.rkey,
          operation: existingInfo ? "update" : "create",
          cid: result.cid,
          value: result.value,
          timeUs: now,
          indexedAt: now,
        }),
      );
    } else if (existingInfo) {
      events.push(
        createIngestEvent({
          uri,
          did: parsed.did,
          collection: parsed.collection,
          rkey: parsed.rkey,
          operation: "delete",
          timeUs: now,
          indexedAt: now,
        }),
      );
    }
  }

  const appliedEvents = events.length > 0
    ? (await ingestRecords(db, events, config, { existing })).accepted
    : [];

  // The shared ingest path fans these records into feed_items exactly like the cron and
  // persistent ingest paths, so prune here too — otherwise a notify-only
  // deployment (no jetstream loop) would never sweep. Run the recovery-aware
  // gate on every call, not only when records changed: a notify-only deployment
  // that receives no-op notifications (a same-CID re-notify produces no events)
  // must still be able to advance an overdue recovery pass. `feedTouched` is
  // true only when this call actually applied a feed-mutating record.
  if (config.feeds) {
    const feedMutatingNsids = getFeedMutatingNsids(config);
    const feedTouched = appliedEvents.some((e) =>
      feedMutatingNsids.has(e.collection),
    );
    await runGatedFeedPrune(db, config, feedTouched);
  }

  return {
    indexed: appliedEvents.filter(
      (event) => event.operation === "create" || event.operation === "update",
    ).length,
    deleted: appliedEvents.filter((event) => event.operation === "delete").length,
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
