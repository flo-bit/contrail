import type {} from "@atcute/atproto";
/**
 * Fresh refresh: re-walk every known DID's PDS for every configured collection
 * and reconcile against what's in our DB. Unlike `backfillPending`, this
 * ignores the `backfills` state machine — it's a "check what we might have
 * missed" pass, not a resumable bulk load.
 *
 * Two categories of delta are counted:
 *   - missing — the PDS has a record we don't
 *   - staleUpdates — we have the same URI but a different CID, *and* our
 *     copy's `indexed_at` is older than `ignoreWindowMs`
 *
 * The ignore window exists because Jetstream can run ~seconds behind the
 * PDS; without the window, "in-sync but racy" writes would show up as
 * misses every run. Records inside the window are still applied (they
 * might be legit updates), just not counted toward stats.
 *
 * Typical uses:
 *   - dev: "I ran backfillAll on Monday, haven't touched it for a week,
 *     how much did jetstream miss?"
 *   - prod: "we had jetstream outage yesterday, what did we drop?"
 */
import { type Did, type Nsid } from "@atcute/lexicons";
import { isDid, isNsid } from "@atcute/lexicons/syntax";

import type { Client } from "@atcute/client";
import type { ContrailConfig, Database, IngestEvent } from "./types.js";
import { applyEvents, lookupExistingRecords } from "./db/records.js";
import { getClient } from "./client.js";

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)
    ),
  ]);
}

export interface CollectionStats {
  /** Record exists on PDS but was absent from our DB. */
  missing: number;
  /** Record exists in our DB with a different CID than the PDS, and our
   *  copy was written before the ignore window. */
  staleUpdates: number;
  /** Record is present and matches (same CID, or within ignore window). */
  inSync: number;
}

export interface RefreshProgress {
  usersComplete: number;
  usersTotal: number;
  usersFailed: number;
  recordsScanned: number;
}

export interface RefreshResult {
  /** Per-NSID stats. */
  byCollection: Record<string, CollectionStats>;
  /** Sum across every NSID. */
  total: CollectionStats;
  usersScanned: number;
  usersFailed: number;
  /** Effective ignore window used for classification, in ms. */
  ignoreWindowMs: number;
  /** Wall-clock runtime, in ms. */
  elapsedMs: number;
}

export interface RefreshOptions {
  /** How many DIDs to fan out against in parallel. Default: 50. */
  concurrency?: number;
  /** Records whose local `indexed_at` is within this window of `now` are
   *  still upserted but excluded from `staleUpdates` counts — guards
   *  against jetstream being briefly behind the PDS. Default: 60_000 ms. */
  ignoreWindowMs?: number;
  /** Override which NSIDs to walk. Default: every `config.collections[*].collection`. */
  nsids?: string[];
  /** Optional progress callback (fires per completed DID). */
  onProgress?: (p: RefreshProgress) => void;
  /** Max attempts per listRecords request. Default: 3. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default: 10000. */
  requestTimeout?: number;
}

function emptyStats(): CollectionStats {
  return { missing: 0, staleUpdates: 0, inSync: 0 };
}

export async function refresh(
  db: Database,
  config: ContrailConfig,
  options?: RefreshOptions
): Promise<RefreshResult> {
  const concurrency = options?.concurrency ?? 50;
  const ignoreWindowMs = options?.ignoreWindowMs ?? 60_000;
  const requestTimeout = options?.requestTimeout ?? REQUEST_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 3;
  const startedAt = Date.now();

  // Default to every configured collection NSID. Profiles are already
  // included because `resolveConfig` adds them to `config.collections`.
  const nsids =
    options?.nsids ??
    Object.values(config.collections).map((c) => c.collection);

  const byCollection: Record<string, CollectionStats> = {};
  for (const nsid of nsids) byCollection[nsid] = emptyStats();
  const total: CollectionStats = emptyStats();

  // Known DIDs = every author we've ever written for. `backfills` is a
  // superset (it also includes failed/pending users that we never got
  // records from), which is actually what we want — if we tried and
  // failed before, we might succeed now.
  const didRows = await db
    .prepare("SELECT DISTINCT did FROM backfills")
    .all<{ did: string }>();
  const dids = (didRows.results ?? [])
    .map((r) => r.did)
    .filter((d) => isDid(d));

  const usersTotal = dids.length;
  let usersComplete = 0;
  let usersFailed = 0;
  let recordsScanned = 0;

  const ignoreBeforeUs = (Date.now() - ignoreWindowMs) * 1000;

  const processDid = async (did: string): Promise<void> => {
    let client: Client;
    try {
      client = await withTimeout(
        () => getClient(did as Did, db),
        requestTimeout
      );
    } catch {
      usersFailed++;
      return;
    }

    for (const nsid of nsids) {
      if (!isNsid(nsid)) continue;
      let cursor: string | undefined;
      while (true) {
        let pageRecords: Array<{ uri: string; cid: string; value: unknown }>;
        let nextCursor: string | undefined;
        try {
          // Retry listRecords: transient PDS failures are expected during refresh
          let attempt = 0;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            try {
              const res = await withTimeout(
                () =>
                  client.get("com.atproto.repo.listRecords", {
                    params: {
                      repo: did as Did,
                      collection: nsid as Nsid,
                      limit: PAGE_SIZE,
                      cursor,
                    },
                  }),
                requestTimeout
              );
              if (!res.ok) {
                // 400s on a collection the user doesn't have are fine; stop
                // paging this collection for this user.
                pageRecords = [];
                nextCursor = undefined;
                break;
              }
              pageRecords = res.data.records;
              nextCursor = res.data.cursor ?? undefined;
              break;
            } catch (err) {
              if (attempt >= maxRetries) throw err;
              attempt++;
              await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
            }
          }
        } catch {
          // Give up on this collection for this user; keep going.
          break;
        }

        if (pageRecords.length === 0) break;

        const now = Date.now();
        const events: IngestEvent[] = pageRecords.map((r) => ({
          uri: r.uri,
          did,
          collection: nsid,
          rkey: r.uri.split("/").pop()!,
          operation: "create" as const,
          cid: r.cid,
          record: JSON.stringify(r.value),
          time_us: now * 1000,
          indexed_at: now * 1000,
        }));

        const existing = await lookupExistingRecords(
          db,
          events.map((e) => ({ uri: e.uri, collection: e.collection })),
          false,
          config
        );

        for (const ev of events) {
          const ex = existing.get(ev.uri);
          if (!ex) {
            byCollection[nsid].missing++;
            total.missing++;
          } else if (ex.cid !== ev.cid) {
            const inWindow =
              ex.indexed_at !== null && ex.indexed_at >= ignoreBeforeUs;
            if (inWindow) {
              byCollection[nsid].inSync++;
              total.inSync++;
            } else {
              byCollection[nsid].staleUpdates++;
              total.staleUpdates++;
            }
          } else {
            byCollection[nsid].inSync++;
            total.inSync++;
          }
        }

        // Upsert everything — even records "inside the ignore window"
        // might genuinely have a new CID; we just don't count them as a
        // miss-signal. Skip feed fanout since this is a catch-up, not a
        // user-visible write.
        await applyEvents(db, events, config, { skipFeedFanout: true });
        recordsScanned += events.length;

        cursor = nextCursor;
        if (!cursor) break;
      }
    }

    usersComplete++;
    options?.onProgress?.({
      usersComplete,
      usersTotal,
      usersFailed,
      recordsScanned,
    });
  };

  for (let i = 0; i < dids.length; i += concurrency) {
    const batch = dids.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(processDid));
  }

  return {
    byCollection,
    total,
    usersScanned: usersComplete,
    usersFailed,
    ignoreWindowMs,
    elapsedMs: Date.now() - startedAt,
  };
}
