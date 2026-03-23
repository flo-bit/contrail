import { type Did } from "@atcute/lexicons";
import { isDid, isNsid } from "@atcute/lexicons/syntax";

import type { Client } from "@atcute/client";
import type { ContrailConfig, Database, IngestEvent } from "./types";
import { getDiscoverableCollections, getDependentCollections, DEFAULT_RELAYS } from "./types";
import { applyEvents } from "./db";
import { getClient, getPDS } from "./client";

const PAGE_SIZE = 100;
const BATCH_SIZE = 100;
const MAX_RETRIES = 5;

const REQUEST_TIMEOUT_MS = 10_000;

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout: ${label}`)), timeoutMs)
        ),
      ]);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

async function markFailed(
  db: Database,
  did: string,
  collection: string,
  error: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE backfills SET retries = retries + 1, last_error = ?, completed = CASE WHEN retries + 1 >= ? THEN 1 ELSE completed END WHERE did = ? AND collection = ?"
    )
    .bind(error, MAX_RETRIES, did, collection)
    .run();
}

export interface BackfillOptions {
  /** Pre-resolved client — avoids redundant PDS lookups when batching by DID */
  client?: Client;
  /** Skip replay detection in applyEvents (safe during initial backfill) */
  skipReplayDetection?: boolean;
  /** Max retries per request (default: 3). Set to 0 for single-attempt mode. */
  maxRetries?: number;
  /** Per-request timeout in ms (default: 10000). */
  requestTimeout?: number;
}

export async function backfillUser(
  db: Database,
  did: string,
  collection: string,
  deadline: number,
  config?: ContrailConfig,
  options?: BackfillOptions
): Promise<number> {
  if (Date.now() >= deadline) return 0;

  const status = await db
    .prepare(
      "SELECT completed, pds_cursor, retries FROM backfills WHERE did = ? AND collection = ?"
    )
    .bind(did, collection)
    .first<{ completed: number; pds_cursor: string | null; retries: number }>();

  if (status?.completed) return 0;

  if (!status) {
    await db
      .prepare(
        "INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 0) ON CONFLICT DO NOTHING"
      )
      .bind(did, collection)
      .run();
  }

  let currentCursor: string | undefined = status?.pds_cursor ?? undefined;
  const retries = options?.maxRetries ?? 3;
  const timeout = options?.requestTimeout ?? REQUEST_TIMEOUT_MS;

  if (!isDid(did)) {
    await markFailed(db, did, collection, `Invalid DID: ${did}`);
    return 0;
  }

  if (!isNsid(collection)) {
    await markFailed(db, did, collection, `Invalid NSID: ${collection}`);
    return 0;
  }

  let client = options?.client;
  if (!client) {
    try {
      client = await withRetry(
        () => getClient(did as Did, db),
        `getClient(${did})`,
        Math.min(retries, 1),
        timeout
      );
    } catch (err) {
      await markFailed(db, did, collection, String(err));
      return 0;
    }
  }

  let totalInserted = 0;
  let done = false;

  try {
    while (Date.now() < deadline) {
      const response = await withRetry(
        () =>
          client!.get("com.atproto.repo.listRecords", {
            params: {
              repo: did as Did,
              collection,
              limit: PAGE_SIZE,
              cursor: currentCursor,
            },
          }),
        `listRecords(${did}/${collection})`,
        retries,
        timeout
      );
      if (!response.ok) {
        await markFailed(
          db,
          did,
          collection,
          `listRecords status ${response.status}`
        );
        return totalInserted;
      }

      if (response.data.records.length === 0) {
        done = true;
        break;
      }

      const now = Date.now();
      const events: IngestEvent[] = response.data.records.map((r) => ({
        uri: r.uri,
        did,
        collection,
        rkey: r.uri.split("/").pop()!,
        operation: "create" as const,
        cid: r.cid,
        record: JSON.stringify(r.value),
        time_us: now * 1000,
        indexed_at: now * 1000,
      }));

      await applyEvents(db, events, config, {
        skipReplayDetection: options?.skipReplayDetection,
      });
      totalInserted += events.length;

      currentCursor = response.data.cursor ?? undefined;

      await db
        .prepare(
          "UPDATE backfills SET pds_cursor = ? WHERE did = ? AND collection = ?"
        )
        .bind(currentCursor ?? null, did, collection)
        .run();

      if (!currentCursor) {
        done = true;
        break;
      }
    }
  } catch (err) {
    await markFailed(db, did, collection, String(err));
    return totalInserted;
  }

  if (done) {
    await db
      .prepare(
        "UPDATE backfills SET completed = 1 WHERE did = ? AND collection = ?"
      )
      .bind(did, collection)
      .run();
  }

  return totalInserted;
}

// --- Bulk backfill (groups by DID, resolves client once) ---

export interface BackfillProgress {
  records: number;
  usersComplete: number;
  usersTotal: number;
  usersFailed: number;
}

export interface BackfillAllOptions {
  concurrency?: number;
  onProgress?: (progress: BackfillProgress) => void;
}

export async function backfillAll(
  db: Database,
  config: ContrailConfig,
  options?: BackfillAllOptions
): Promise<number> {
  const concurrency = options?.concurrency ?? 100;
  let totalBackfilled = 0;

  while (true) {
    const pending = await db
      .prepare(
        "SELECT did, collection FROM backfills WHERE completed = 0 ORDER BY did"
      )
      .all<{ did: string; collection: string }>();

    const rows = pending.results ?? [];
    if (rows.length === 0) break;

    // Group by DID so we resolve PDS once per user
    const byDid = new Map<string, string[]>();
    for (const row of rows) {
      const cols = byDid.get(row.did) ?? [];
      cols.push(row.collection);
      byDid.set(row.did, cols);
    }

    const dids = [...byDid.keys()];

    // Resolve PDS endpoints in background (populates in-memory cache)
    const resolvePromise = (async () => {
      for (let i = 0; i < dids.length; i += 200) {
        await Promise.allSettled(
          dids.slice(i, i + 200).map((did) =>
            getPDS(did as Did, db).catch(() => {})
          )
        );
      }
    })();

    let roundBackfilled = 0;
    let usersComplete = 0;
    let usersFailed = 0;
    const failedDids: string[] = [];

    const FAST_TIMEOUT = 3_000;

    const emitProgress = () =>
      options?.onProgress?.({
        records: totalBackfilled + roundBackfilled,
        usersComplete,
        usersTotal: dids.length,
        usersFailed,
      });

    // Fast pass: single attempt per user with short timeout
    for (let i = 0; i < dids.length; i += concurrency) {
      const batch = dids.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map(async (did) => {
          let client: Client | undefined;
          try {
            client = await withRetry(
              () => getClient(did as Did, db),
              `getClient(${did})`,
              0,
              FAST_TIMEOUT
            );
          } catch {
            failedDids.push(did);
            return 0;
          }

          const cols = byDid.get(did)!;
          const counts = await Promise.all(
            cols.map((col) =>
              backfillUser(db, did, col, Infinity, config, {
                client,
                skipReplayDetection: true,
                maxRetries: 0,
                requestTimeout: FAST_TIMEOUT,
              }).catch(() => {
                failedDids.push(did);
                return 0;
              })
            )
          );

          usersComplete++;
          return counts.reduce((a, b) => a + b, 0);
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") roundBackfilled += r.value;
      }

      emitProgress();
    }

    // Retry pass: failed DIDs get retries with backoff, still in concurrent batches
    if (failedDids.length > 0) {
      const uniqueFailed = [...new Set(failedDids)];
      usersComplete -= uniqueFailed.length; // don't count them yet

      for (let i = 0; i < uniqueFailed.length; i += concurrency) {
        const batch = uniqueFailed.slice(i, i + concurrency);

        const results = await Promise.allSettled(
          batch.map(async (did) => {
            let client: Client | undefined;
            try {
              client = await withRetry(
                () => getClient(did as Did, db),
                `getClient(${did})`,
                2
              );
            } catch (err) {
              for (const col of byDid.get(did)!) {
                await markFailed(db, did, col, String(err));
              }
              usersFailed++;
              usersComplete++;
              return 0;
            }

            const cols = byDid.get(did)!;
            const counts = await Promise.all(
              cols.map((col) =>
                backfillUser(db, did, col, Infinity, config, {
                  client,
                  skipReplayDetection: true,
                  maxRetries: 2,
                })
              )
            );
            usersComplete++;
            return counts.reduce((a, b) => a + b, 0);
          })
        );

        for (const r of results) {
          if (r.status === "fulfilled") roundBackfilled += r.value;
        }

        emitProgress();
      }
    }

    await resolvePromise;
    totalBackfilled += roundBackfilled;

    // If nothing was backfilled this round, we're stuck
    if (roundBackfilled === 0) break;
  }

  return totalBackfilled;
}

// --- Discovery ---

interface DiscoveryPage {
  repos: { did: string }[];
  cursor?: string;
}

async function fetchPage(
  relay: string,
  collection: string,
  cursor?: string
): Promise<DiscoveryPage | null> {
  const url = new URL(
    `/xrpc/com.atproto.sync.listReposByCollection`,
    relay
  );
  url.searchParams.set("collection", collection);
  url.searchParams.set("limit", "1000");
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  try {
    return await withRetry(
      async () => {
        const response = await fetch(url.toString());
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return (await response.json()) as DiscoveryPage;
      },
      `fetchPage(${relay}, ${collection})`
    );
  } catch (err) {
    console.error(
      `Discovery failed for ${collection} from ${relay} after retries: ${err}`
    );
    return null;
  }
}

async function insertDiscoveredDIDs(
  db: Database,
  dids: string[],
  collection: string
): Promise<void> {
  if (dids.length === 0) return;

  const stmt = db.prepare(
    "INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 0) ON CONFLICT DO NOTHING"
  );

  const batch = dids.map((did) => stmt.bind(did, collection));

  for (let i = 0; i < batch.length; i += 50) {
    await db.batch(batch.slice(i, i + 50));
  }
}

async function saveDiscoveryState(
  db: Database,
  collection: string,
  relay: string,
  cursor: string | null,
  completed: boolean
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO discovery (collection, relay, cursor, completed) VALUES (?, ?, ?, ?) ON CONFLICT(collection, relay) DO UPDATE SET cursor = excluded.cursor, completed = excluded.completed"
    )
    .bind(collection, relay, cursor, completed ? 1 : 0)
    .run();
}

export async function discoverDIDs(
  db: Database,
  config: ContrailConfig,
  deadline: number
): Promise<string[]> {
  const collections = getDiscoverableCollections(config);
  const relays = config.relays ?? DEFAULT_RELAYS;
  if (relays.length === 0 || collections.length === 0) return [];

  const discovered: string[] = [];

  for (const collection of collections) {
    if (Date.now() >= deadline) break;

    let data: DiscoveryPage | null = null;
    let relay: string | null = null;

    for (const r of relays) {
      const row = await db
        .prepare(
          "SELECT cursor, completed FROM discovery WHERE collection = ? AND relay = ?"
        )
        .bind(collection, r)
        .first<{ cursor: string | null; completed: number }>();

      if (row?.completed) continue;

      data = await fetchPage(r, collection, row?.cursor ?? undefined);
      if (data) {
        relay = r;
        break;
      } else {
        await saveDiscoveryState(db, collection, r, null, true);
      }
    }
    if (!data || !relay) continue;

    const dids = data.repos?.map((r) => r.did) ?? [];
    await insertDiscoveredDIDs(db, dids, collection);
    discovered.push(...dids);

    for (const depCollection of getDependentCollections(config)) {
      await insertDiscoveredDIDs(db, dids, depCollection);
    }

    const completed = !data.cursor;
    await saveDiscoveryState(db, collection, relay, data.cursor ?? null, completed);
  }

  return discovered;
}
