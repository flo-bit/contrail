import { type Did } from "@atcute/lexicons";

import type { Client } from "@atcute/client";
import type { ContrailConfig, Database } from "./types";
import {
  getDiscoverableNsids,
  getDependentNsids,
  DEFAULT_RELAYS,
} from "./types";
import { getLastCursor, saveCursor } from "./db";
import { getClient, getPDS } from "./client";
import { isExcluded, sweepUserFilter } from "./user-filter";
import {
  backfillUserCar,
  markRepoComplete,
  markRepoFailed,
} from "./backfill-car";
import type { BackfillCarOptions } from "./backfill-car";
import { backfillUserListRecords } from "./backfill-list-records";
import type { BackfillListRecordsOptions } from "./backfill-list-records";

const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 10_000;

async function countExcluded(db: Database): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS c FROM identities WHERE excluded = 1")
    .first<{ c: number }>();
  return Number(r?.c ?? 0);
}

/**
 * Resolve identities for every DID in `dids` in parallel batches. This
 * populates the `identities` table and — when `config.userFilter` is set —
 * lets the filter mark exclusions (and delete the matching `backfills` rows)
 * BEFORE the per-user backfill loop runs. Without this, excluded users
 * still pay for a full slingshot resolve + getClient throw cycle inside
 * each concurrency slot, which is the slow path when most of your population
 * is filtered out.
 *
 * No-op when no filter is configured (the per-user loop already pre-warms
 * the PDS cache in the background).
 */
async function preResolveIdentitiesForFilter(
  db: Database,
  config: ContrailConfig,
  dids: string[],
  concurrency = 200
): Promise<void> {
  if (!config.userFilter || dids.length === 0) return;
  for (let i = 0; i < dids.length; i += concurrency) {
    await Promise.allSettled(
      dids
        .slice(i, i + concurrency)
        .map((did) => getPDS(did as Did, db, config).catch(() => {}))
    );
  }
}

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

export interface BackfillOptions
  extends BackfillListRecordsOptions,
    BackfillCarOptions {}

function getBackfillMethod(config?: ContrailConfig): "car" | "listRecords" {
  return config?.backfillMethod ?? "listRecords";
}

/**
 * Ensure this user's records are backfilled. Dispatches on
 * `config.backfillMethod`:
 *   - `"listRecords"` (default): per-collection paginated walk.
 *   - `"car"`: one CAR fetch covering every configured collection.
 *
 * Excluded users (`identities.excluded = 1`) short-circuit to 0.
 */
export async function backfillUser(
  db: Database,
  did: string,
  collection: string,
  deadline: number,
  config: ContrailConfig | undefined,
  options?: BackfillOptions
): Promise<number> {
  if (Date.now() >= deadline) return 0;
  if (await isExcluded(db, did)) return 0;

  if (getBackfillMethod(config) === "car") {
    return backfillUserViaCar(db, did, collection, deadline, config, options);
  }
  return backfillUserListRecords(db, did, collection, deadline, config, options);
}

/** CAR-flavored wrapper that gates on the (did, collection) row but always
 *  fetches the whole repo. Once the CAR succeeds, every (did, *) row gets
 *  marked complete in one statement. */
async function backfillUserViaCar(
  db: Database,
  did: string,
  collection: string,
  deadline: number,
  config: ContrailConfig | undefined,
  options?: BackfillOptions
): Promise<number> {
  if (!config) return 0;

  const status = await db
    .prepare(
      "SELECT completed FROM backfills WHERE did = ? AND collection = ?"
    )
    .bind(did, collection)
    .first<{ completed: number }>();

  if (status?.completed) return 0;

  if (!status) {
    await db
      .prepare(
        "INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 0) ON CONFLICT DO NOTHING"
      )
      .bind(did, collection)
      .run();
  }

  const retries = options?.maxRetries ?? 3;
  const timeout = options?.requestTimeout ?? REQUEST_TIMEOUT_MS;

  try {
    const result = await withRetry(
      () =>
        backfillUserCar(db, did, deadline, config, {
          ...options,
          requestTimeout: timeout,
        }),
      `backfillUserCar(${did})`,
      retries,
      timeout
    );
    return result.inserted;
  } catch (err) {
    await markRepoFailed(db, did, String(err));
    return 0;
  }
}

// --- Bulk backfill ---

export interface BackfillProgress {
  records: number;
  usersComplete: number;
  usersTotal: number;
  usersFailed: number;
  /** Identities currently flagged `excluded = 1` (matched `config.userFilter`). */
  usersExcluded: number;
}

export interface BackfillAllOptions {
  concurrency?: number;
  onProgress?: (progress: BackfillProgress) => void;
}

export async function backfillPending(
  db: Database,
  config: ContrailConfig,
  options?: BackfillAllOptions
): Promise<number> {
  // Anchor the jetstream cursor to now if it hasn't been set yet, so records
  // emitted during backfill are replayed once jetstream starts.
  if ((await getLastCursor(db)) === null) {
    await saveCursor(db, Date.now() * 1000);
  }

  // Reset retries so users that hit the cap in a prior run get another chance.
  await db
    .prepare("UPDATE backfills SET retries = 0 WHERE completed = 0")
    .run();

  // Apply userFilter to all identities — catches users resolved before the
  // filter was configured. Returns the running excluded count for progress.
  const log = config.logger ?? console;
  const sweep = await sweepUserFilter(db, config);
  if (sweep.newlyExcluded > 0) {
    log.log?.(
      `[backfill] userFilter excluded ${sweep.newlyExcluded} new user(s) (${sweep.totalExcluded} total)`
    );
  } else if (sweep.totalExcluded > 0) {
    log.log?.(
      `[backfill] ${sweep.totalExcluded} user(s) excluded by userFilter (skipped)`
    );
  }

  return getBackfillMethod(config) === "car"
    ? backfillPendingCar(db, config, options, sweep.totalExcluded)
    : backfillPendingListRecords(db, config, options, sweep.totalExcluded);
}

/** Per-(did, collection) listRecords loop. Groups by DID so the PDS lookup
 *  and `getClient` happen once per user. */
async function backfillPendingListRecords(
  db: Database,
  config: ContrailConfig,
  options?: BackfillAllOptions,
  usersExcluded = 0
): Promise<number> {
  const concurrency = options?.concurrency ?? 100;
  let totalBackfilled = 0;

  const log = config.logger ?? console;

  while (true) {
    let pending = await db
      .prepare(
        `SELECT b.did, b.collection
         FROM backfills b
         LEFT JOIN identities i ON i.did = b.did
         WHERE b.completed = 0 AND b.retries < ? AND COALESCE(i.excluded, 0) = 0
         ORDER BY b.did`
      )
      .bind(MAX_RETRIES)
      .all<{ did: string; collection: string }>();

    let rows = pending.results ?? [];
    if (rows.length === 0) break;

    // When userFilter is set, resolve identities upfront for every pending
    // DID so exclusions take effect (and matching backfills rows get
    // deleted) before the slow listRecords loop spins up. Then re-query.
    if (config.userFilter) {
      const allDids = [...new Set(rows.map((r) => r.did))];
      const before = Date.now();
      log.log?.(
        `[backfill] pre-resolving ${allDids.length} identities to apply userFilter…`
      );
      await preResolveIdentitiesForFilter(db, config, allDids);
      pending = await db
        .prepare(
          `SELECT b.did, b.collection
           FROM backfills b
           LEFT JOIN identities i ON i.did = b.did
           WHERE b.completed = 0 AND b.retries < ? AND COALESCE(i.excluded, 0) = 0
           ORDER BY b.did`
        )
        .bind(MAX_RETRIES)
        .all<{ did: string; collection: string }>();
      const filteredRows = pending.results ?? [];
      const droppedDids =
        allDids.length - new Set(filteredRows.map((r) => r.did)).size;
      log.log?.(
        `[backfill] pre-resolve done in ${(
          (Date.now() - before) /
          1000
        ).toFixed(1)}s — ${droppedDids} excluded, ${
          filteredRows.length
        } (did, collection) rows remaining`
      );
      rows = filteredRows;
      if (rows.length === 0) break;
    }

    // Group by DID so we resolve PDS once per user
    const byDid = new Map<string, string[]>();
    for (const row of rows) {
      const cols = byDid.get(row.did) ?? [];
      cols.push(row.collection);
      byDid.set(row.did, cols);
    }

    const dids = [...byDid.keys()];

    // Resolve PDS endpoints in background (populates in-memory cache).
    // Skipped when we already pre-resolved above for the filter sweep.
    const resolvePromise = config.userFilter
      ? Promise.resolve()
      : (async () => {
          for (let i = 0; i < dids.length; i += 200) {
            await Promise.allSettled(
              dids.slice(i, i + 200).map((did) =>
                getPDS(did as Did, db, config).catch(() => {})
              )
            );
          }
        })();

    let roundBackfilled = 0;
    let usersComplete = 0;
    let usersFailed = 0;
    const failedDids = new Set<string>();

    const FAST_TIMEOUT = 3_000;
    const hasFilter = !!config.userFilter;

    const emitProgress = async () => {
      if (hasFilter) usersExcluded = await countExcluded(db);
      options?.onProgress?.({
        records: totalBackfilled + roundBackfilled,
        usersComplete,
        usersTotal: dids.length,
        usersFailed,
        usersExcluded,
      });
    };

    // Fast pass: single attempt per user with short timeout. Only count
    // toward `usersComplete` when *every* collection for the DID succeeds —
    // partial failures get punted to the retry pass and accounted there.
    for (let i = 0; i < dids.length; i += concurrency) {
      const batch = dids.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map(async (did) => {
          let client: Client | undefined;
          try {
            client = await withRetry(
              () => getClient(did as Did, db, config),
              `getClient(${did})`,
              0,
              FAST_TIMEOUT
            );
          } catch {
            // Distinguish "filter excluded the user" from a real PDS failure —
            // the userFilter side-channel marks identities.excluded=1, so a
            // getClient failure on an excluded DID is a clean skip, not a
            // failure to retry.
            if (hasFilter && (await isExcluded(db, did))) {
              usersComplete++;
              return 0;
            }
            failedDids.add(did);
            return 0;
          }

          const cols = byDid.get(did)!;
          let anyFailed = false;
          const counts = await Promise.all(
            cols.map((col) =>
              backfillUserListRecords(db, did, col, Infinity, config, {
                client,
                skipReplayDetection: true,
                maxRetries: 0,
                requestTimeout: FAST_TIMEOUT,
              }).catch(() => {
                anyFailed = true;
                return 0;
              })
            )
          );

          if (anyFailed) failedDids.add(did);
          else usersComplete++;
          return counts.reduce((a, b) => a + b, 0);
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") roundBackfilled += r.value;
      }

      await emitProgress();
    }

    // Retry pass: failed DIDs get retries with backoff, still in concurrent batches
    if (failedDids.size > 0) {
      const uniqueFailed = [...failedDids];

      for (let i = 0; i < uniqueFailed.length; i += concurrency) {
        const batch = uniqueFailed.slice(i, i + concurrency);

        const results = await Promise.allSettled(
          batch.map(async (did) => {
            let client: Client | undefined;
            try {
              client = await withRetry(
                () => getClient(did as Did, db, config),
                `getClient(${did})`,
                2
              );
            } catch (err) {
              // Same exclusion-vs-failure distinction as the fast pass.
              if (hasFilter && (await isExcluded(db, did))) {
                usersComplete++;
                return 0;
              }
              for (const col of byDid.get(did)!) {
                await db
                  .prepare(
                    "UPDATE backfills SET retries = retries + 1, last_error = ? WHERE did = ? AND collection = ?"
                  )
                  .bind(String(err), did, col)
                  .run();
              }
              usersFailed++;
              usersComplete++;
              return 0;
            }

            const cols = byDid.get(did)!;
            const counts = await Promise.all(
              cols.map((col) =>
                backfillUserListRecords(db, did, col, Infinity, config, {
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

        await emitProgress();
      }
    }

    await resolvePromise;
    totalBackfilled += roundBackfilled;

    // If nothing was backfilled this round, we're stuck
    if (roundBackfilled === 0) break;
  }

  return totalBackfilled;
}

/** Per-DID CAR loop. One `com.atproto.sync.getRepo` call per user covers
 *  every configured collection in one pass. */
async function backfillPendingCar(
  db: Database,
  config: ContrailConfig,
  options?: BackfillAllOptions,
  usersExcluded = 0
): Promise<number> {
  const concurrency = options?.concurrency ?? 50;
  let totalBackfilled = 0;

  const log = config.logger ?? console;

  while (true) {
    let pending = await db
      .prepare(
        `SELECT DISTINCT b.did
         FROM backfills b
         LEFT JOIN identities i ON i.did = b.did
         WHERE b.completed = 0 AND b.retries < ? AND COALESCE(i.excluded, 0) = 0
         ORDER BY b.did`
      )
      .bind(MAX_RETRIES)
      .all<{ did: string }>();

    let dids = (pending.results ?? []).map((r) => r.did);
    if (dids.length === 0) break;

    // Pre-resolve identities so userFilter can prune the list before we
    // start firing CAR fetches.
    if (config.userFilter) {
      const before = Date.now();
      log.log?.(
        `[backfill] pre-resolving ${dids.length} identities to apply userFilter…`
      );
      await preResolveIdentitiesForFilter(db, config, dids);
      pending = await db
        .prepare(
          `SELECT DISTINCT b.did
           FROM backfills b
           LEFT JOIN identities i ON i.did = b.did
           WHERE b.completed = 0 AND b.retries < ? AND COALESCE(i.excluded, 0) = 0
           ORDER BY b.did`
        )
        .bind(MAX_RETRIES)
        .all<{ did: string }>();
      const filtered = (pending.results ?? []).map((r) => r.did);
      log.log?.(
        `[backfill] pre-resolve done in ${(
          (Date.now() - before) /
          1000
        ).toFixed(1)}s — ${dids.length - filtered.length} excluded, ${
          filtered.length
        } users remaining`
      );
      dids = filtered;
      if (dids.length === 0) break;
    }

    const resolvePromise = config.userFilter
      ? Promise.resolve()
      : (async () => {
          for (let i = 0; i < dids.length; i += 200) {
            await Promise.allSettled(
              dids
                .slice(i, i + 200)
                .map((did) => getPDS(did as Did, db, config).catch(() => {}))
            );
          }
        })();

    let roundBackfilled = 0;
    let usersComplete = 0;
    let usersFailed = 0;
    const failedDids = new Set<string>();

    const FAST_TIMEOUT = 30_000;
    const hasFilter = !!config.userFilter;

    const emitProgress = async () => {
      if (hasFilter) usersExcluded = await countExcluded(db);
      options?.onProgress?.({
        records: totalBackfilled + roundBackfilled,
        usersComplete,
        usersTotal: dids.length,
        usersFailed,
        usersExcluded,
      });
    };

    for (let i = 0; i < dids.length; i += concurrency) {
      const batch = dids.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map(async (did) => {
          try {
            const r = await backfillUserCar(db, did, Infinity, config, {
              skipReplayDetection: true,
              requestTimeout: FAST_TIMEOUT,
            });
            usersComplete++;
            return r.inserted;
          } catch {
            // Filter exclusion looks like a "PDS not found" failure here.
            if (hasFilter && (await isExcluded(db, did))) {
              usersComplete++;
              return 0;
            }
            failedDids.add(did);
            return 0;
          }
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") roundBackfilled += r.value;
      }
      await emitProgress();
    }

    if (failedDids.size > 0) {
      const uniqueFailed = [...failedDids];
      for (let i = 0; i < uniqueFailed.length; i += concurrency) {
        const batch = uniqueFailed.slice(i, i + concurrency);

        const results = await Promise.allSettled(
          batch.map(async (did) => {
            try {
              const r = await withRetry(
                () =>
                  backfillUserCar(db, did, Infinity, config, {
                    skipReplayDetection: true,
                    requestTimeout: FAST_TIMEOUT * 2,
                  }),
                `backfillUserCar(${did})`,
                2,
                FAST_TIMEOUT * 2
              );
              usersComplete++;
              return r.inserted;
            } catch (err) {
              if (hasFilter && (await isExcluded(db, did))) {
                usersComplete++;
                return 0;
              }
              await markRepoFailed(db, did, String(err));
              usersFailed++;
              usersComplete++;
              return 0;
            }
          })
        );

        for (const r of results) {
          if (r.status === "fulfilled") roundBackfilled += r.value;
        }
        await emitProgress();
      }
    }

    await resolvePromise;
    totalBackfilled += roundBackfilled;

    if (roundBackfilled === 0) break;
  }

  return totalBackfilled;
}

// Re-export helpers used outside this module.
export { backfillUserCar, markRepoComplete, markRepoFailed };
export type { BackfillCarOptions };
export { backfillUserListRecords };
export type { BackfillListRecordsOptions };

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
    // Discovery page fetch failed after retries — skip this relay
    return null;
  }
}

async function insertDiscoveredDIDs(
  db: Database,
  dids: string[],
  collection: string
): Promise<void> {
  if (dids.length === 0) return;

  // Use multi-row INSERT to reduce the number of statements
  const CHUNK_SIZE = 50;
  for (let i = 0; i < dids.length; i += CHUNK_SIZE) {
    const chunk = dids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "(?, ?, 0)").join(", ");
    const bindings: string[] = [];
    for (const did of chunk) {
      bindings.push(did, collection);
    }
    await db
      .prepare(
        `INSERT INTO backfills (did, collection, completed) VALUES ${placeholders} ON CONFLICT DO NOTHING`
      )
      .bind(...bindings)
      .run();
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
  const collections = getDiscoverableNsids(config);
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

    for (const depCollection of getDependentNsids(config)) {
      await insertDiscoveredDIDs(db, dids, depCollection);
    }

    const completed = !data.cursor;
    await saveDiscoveryState(db, collection, relay, data.cursor ?? null, completed);
  }

  return discovered;
}
