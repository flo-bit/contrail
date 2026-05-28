/**
 * CAR-based backfill: fetch a user's entire repo via
 * `com.atproto.sync.getRepo` and stream-decode it with `@atcute/repo`.
 *
 * One HTTP request per DID covers every configured collection — replaces
 * paginated `com.atproto.repo.listRecords` walks (one per collection) and
 * is dramatically faster on users with several configured collections or
 * deep history.
 */
import { type Did } from "@atcute/lexicons";
import { isDid } from "@atcute/lexicons/syntax";
import * as Repo from "@atcute/repo";

import type { ContrailConfig, Database, IngestEvent } from "./types";
import { getCollectionNsids } from "./types";
import { applyEvents } from "./db";
import { getPDS } from "./client";
import { recordTimeUs, filterEventsBySubject } from "./backfill-shared";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const BATCH_SIZE = 100;

export interface BackfillCarOptions {
  /** Skip replay detection in applyEvents (safe during initial backfill). */
  skipReplayDetection?: boolean;
  /** Per-request timeout in ms (default: 60000). */
  requestTimeout?: number;
  /** Abort the in-flight fetch (rolled into the timeout). */
  signal?: AbortSignal;
}

export interface BackfillCarResult {
  /** Records inserted across every configured collection. */
  inserted: number;
  /** Streamed entries that matched a configured collection. */
  matched: number;
}

/**
 * Stream the user's repo CAR and apply records for every configured
 * collection. Marks every `(did, *)` row in the `backfills` table complete
 * on success. Throws on PDS resolution / fetch / parse errors so the caller
 * can attribute the failure.
 */
export async function backfillUserCar(
  db: Database,
  did: string,
  deadline: number,
  config: ContrailConfig,
  options?: BackfillCarOptions
): Promise<BackfillCarResult> {
  if (Date.now() >= deadline) return { inserted: 0, matched: 0 };
  if (!isDid(did)) throw new Error(`Invalid DID: ${did}`);

  const wantedNsids = new Set(getCollectionNsids(config));
  if (wantedNsids.size === 0) {
    await markRepoComplete(db, did);
    return { inserted: 0, matched: 0 };
  }

  const subjectFields = collectSubjectFields(config);

  const pds = await getPDS(did as Did, db);
  if (!pds) throw new Error(`PDS not found for ${did}`);

  const url = new URL("/xrpc/com.atproto.sync.getRepo", pds);
  url.searchParams.set("did", did);

  const timeoutMs = options?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const ctrl = new AbortController();
  const onUserAbort = () => ctrl.abort(options?.signal?.reason);
  options?.signal?.addEventListener("abort", onUserAbort);
  const timer = setTimeout(
    () => ctrl.abort(new Error(`Timeout: getRepo(${did})`)),
    timeoutMs
  );

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: { accept: "application/vnd.ipld.car" },
    });
  } catch (err) {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onUserAbort);
    throw err;
  }

  if (!response.ok || !response.body) {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onUserAbort);
    throw new Error(`getRepo HTTP ${response.status}`);
  }

  const nowUs = Date.now() * 1000;
  let inserted = 0;
  let matched = 0;
  const buffers = new Map<string, IngestEvent[]>();

  const flush = async (collection: string): Promise<void> => {
    const events = buffers.get(collection);
    if (!events || events.length === 0) return;
    buffers.set(collection, []);

    let toApply = events;
    const subjectField = subjectFields.get(collection);
    if (subjectField) {
      toApply = await filterEventsBySubject(db, events, subjectField);
    }
    if (toApply.length > 0) {
      await applyEvents(db, toApply, config, {
        skipReplayDetection: options?.skipReplayDetection,
        skipFeedFanout: true,
      });
      inserted += toApply.length;
    }
  };

  const reader = Repo.fromStream(response.body);
  try {
    for await (const entry of reader) {
      if (Date.now() >= deadline) {
        throw new Error(`Deadline exceeded mid-stream for ${did}`);
      }
      if (!wantedNsids.has(entry.collection)) continue;

      matched++;
      const buf = buffers.get(entry.collection) ?? [];
      const record = entry.record;
      buf.push({
        uri: `at://${did}/${entry.collection}/${entry.rkey}`,
        did,
        collection: entry.collection,
        rkey: entry.rkey,
        operation: "create",
        cid: entry.cid.$link,
        record: JSON.stringify(record),
        time_us: recordTimeUs(record, entry.collection, config, nowUs),
        indexed_at: nowUs,
      });
      buffers.set(entry.collection, buf);

      if (buf.length >= BATCH_SIZE) {
        await flush(entry.collection);
      }
    }

    for (const collection of [...buffers.keys()]) {
      await flush(collection);
    }
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onUserAbort);
    await reader.dispose();
  }

  await markRepoComplete(db, did);
  return { inserted, matched };
}

/** Mark every `(did, *)` row in `backfills` complete in one statement. */
export async function markRepoComplete(
  db: Database,
  did: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE backfills SET completed = 1, last_error = NULL WHERE did = ?"
    )
    .bind(did)
    .run();
}

/** Bump `retries` and stamp `last_error` on every `(did, *)` row. */
export async function markRepoFailed(
  db: Database,
  did: string,
  error: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE backfills SET retries = retries + 1, last_error = ? WHERE did = ?"
    )
    .bind(error, did)
    .run();
}

/** Build NSID → subjectField map for collections that declare one. */
function collectSubjectFields(config: ContrailConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of Object.values(config.collections)) {
    if (c.subjectField) out.set(c.collection, c.subjectField);
  }
  return out;
}
