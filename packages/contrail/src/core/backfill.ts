import type {} from "@atcute/atproto";
import { type Did } from "@atcute/lexicons";
import { isDid, isNsid } from "@atcute/lexicons/syntax";

import type { Client } from "@atcute/client";
import type { ContrailConfig, Database, IngestEvent } from "./types";
import {
  getDiscoverableNsids,
  getDependentNsids,
  DEFAULT_RELAYS,
  shortNameForNsid,
} from "./types";
import { getLastCursor, saveCursor } from "./db";
import { createIngestEvent, ingestRecords } from "./ingest";
import { getClient, getPDS } from "./client";
import {
  finishBackfillRun,
  heartbeatBackfillRun,
  tryStartBackfillRun,
} from "./status";

const DEFAULT_TIME_FIELD = "createdAt";

/** Parse the record's canonical time (e.g. createdAt) and return microseconds.
 *  Falls back to `nowUs` when missing/invalid. Clamps to nowUs to avoid
 *  user-controlled future timestamps pinning records at the top of feeds. */
function recordTimeUs(
  record: unknown,
  collection: string,
  config: ContrailConfig,
  nowUs: number
): number {
  const short = shortNameForNsid(config, collection);
  const colCfg = short ? config.collections[short] : undefined;
  const field = colCfg?.timeField ?? DEFAULT_TIME_FIELD;
  if (field === false) return nowUs;
  const raw =
    record && typeof record === "object"
      ? (record as Record<string, unknown>)[field]
      : undefined;
  if (typeof raw !== "string") return nowUs;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms <= 0) return nowUs;
  const us = ms * 1000;
  return us > nowUs ? nowUs : us;
}

const PAGE_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;

const REQUEST_TIMEOUT_MS = 10_000;
const BACKFILL_RETRY_BASE_MS = 60_000;
const BACKFILL_RETRY_MAX_MS = 60 * 60_000;

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
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

function errorMessage(error: unknown): string {
  return String(error).slice(0, 1_000);
}

async function markFailed(
  db: Database,
  did: string,
  collection: string,
  error: unknown
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT retries FROM backfills WHERE did = ? AND collection = ?"
    )
    .bind(did, collection)
    .first<{ retries: number }>();
  const retries = (row?.retries ?? 0) + 1;
  const now = Date.now();
  const retryDelay = Math.min(
    BACKFILL_RETRY_BASE_MS * 2 ** Math.min(retries - 1, 6),
    BACKFILL_RETRY_MAX_MS
  );
  await db
    .prepare(
      "UPDATE backfills SET retries = ?, last_error = ?, last_attempt_at = ?, next_retry_at = ? WHERE did = ? AND collection = ?"
    )
    .bind(
      retries,
      errorMessage(error),
      now,
      now + retryDelay,
      did,
      collection
    )
    .run();
}

export interface BackfillOptions {
  /** Pre-resolved client — avoids redundant PDS lookups when batching by DID */
  client?: Client;
  /** Skip replay detection during initial backfill. */
  skipReplayDetection?: boolean;
  /** Max retries per request (default: 3). Set to 0 for single-attempt mode. */
  maxRetries?: number;
  /** Per-request timeout in ms (default: 10000). */
  requestTimeout?: number;
}

interface BackfillUserAttempt {
  records: number;
  completed: boolean;
}

async function backfillUserAttempt(
  db: Database,
  did: string,
  collection: string,
  deadline: number,
  config: ContrailConfig,
  options?: BackfillOptions
): Promise<BackfillUserAttempt> {
  if (Date.now() >= deadline) return { records: 0, completed: false };

  const status = await db
    .prepare(
      "SELECT completed, pds_cursor, retries FROM backfills WHERE did = ? AND collection = ?"
    )
    .bind(did, collection)
    .first<{ completed: number; pds_cursor: string | null; retries: number }>();

  if (status?.completed) return { records: 0, completed: true };

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
    return { records: 0, completed: false };
  }

  if (!isNsid(collection)) {
    await markFailed(db, did, collection, `Invalid NSID: ${collection}`);
    return { records: 0, completed: false };
  }

  let client = options?.client;
  if (!client) {
    try {
      client = await withRetry(
        () => getClient(did as Did, db, config),
        `getClient(${did})`,
        Math.min(retries, 1),
        timeout
      );
    } catch (err) {
      await markFailed(db, did, collection, err);
      return { records: 0, completed: false };
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
        const detail = response.data.message
          ? `${response.data.error}: ${response.data.message}`
          : response.data.error;
        await markFailed(
          db,
          did,
          collection,
          `listRecords status ${response.status} (${detail})`
        );
        return { records: totalInserted, completed: false };
      }

      if (response.data.records.length === 0) {
        done = true;
        break;
      }

      const now = Date.now();
      const nowUs = now * 1000;
      const events: IngestEvent[] = response.data.records.map((record) =>
        createIngestEvent({
          uri: record.uri,
          did,
          collection,
          rkey: record.uri.split("/").pop()!,
          operation: "create",
          cid: record.cid,
          value: record.value,
          timeUs: recordTimeUs(record.value, collection, config, nowUs),
          indexedAt: nowUs,
        }),
      );

      if (events.length > 0) {
        const result = await ingestRecords(db, events, config, {
          skipReplayDetection: options?.skipReplayDetection,
          skipFeedFanout: true,
          // Let sinks bulk-flush differently from live ingestion.
          phase: "backfill",
        });
        totalInserted += result.accepted.length;
      }

      currentCursor = response.data.cursor ?? undefined;

      await db
        .prepare(
          "UPDATE backfills SET pds_cursor = ?, retries = 0, last_error = NULL, last_attempt_at = ?, next_retry_at = NULL WHERE did = ? AND collection = ?"
        )
        .bind(currentCursor ?? null, now, did, collection)
        .run();

      if (!currentCursor) {
        done = true;
        break;
      }
    }
  } catch (err) {
    await markFailed(db, did, collection, err);
    return { records: totalInserted, completed: false };
  }

  if (done) {
    await db
      .prepare(
        "UPDATE backfills SET completed = 1, retries = 0, last_error = NULL, last_attempt_at = ?, next_retry_at = NULL WHERE did = ? AND collection = ?"
      )
      .bind(Date.now(), did, collection)
      .run();
  }

  return { records: totalInserted, completed: done };
}

export async function backfillUser(
  db: Database,
  did: string,
  collection: string,
  deadline: number,
  config: ContrailConfig,
  options?: BackfillOptions
): Promise<number> {
  const result = await backfillUserAttempt(
    db,
    did,
    collection,
    deadline,
    config,
    options
  );
  return result.records;
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
  /** Failed account/collection attempts allowed in one run before leaving the
   * row pending for a future run. Default: 5. */
  maxAttempts?: number;
  onProgress?: (progress: BackfillProgress) => void;
}

async function backfillPendingWork(
  db: Database,
  config: ContrailConfig,
  options: BackfillAllOptions | undefined,
  runId: string
): Promise<number> {
  const concurrency = positiveInteger(options?.concurrency, 100);
  const maxAttempts = positiveInteger(
    options?.maxAttempts,
    DEFAULT_MAX_ATTEMPTS
  );
  let totalBackfilled = 0;

  // Anchor the jetstream cursor to now if it hasn't been set yet, so records
  // emitted during backfill are replayed once jetstream starts.
  if ((await getLastCursor(db)) === null) {
    await saveCursor(db, Date.now() * 1000);
  }

  // The attempt cap is per invocation. Rows remain incomplete and a later run
  // gets a fresh bounded retry budget.
  await db
    .prepare("UPDATE backfills SET retries = 0 WHERE completed = 0")
    .run();

  while (true) {
    const pending = await db
      .prepare(
        "SELECT did, collection FROM backfills WHERE completed = 0 AND retries < ? ORDER BY did"
      )
      .bind(maxAttempts)
      .all<{ did: string; collection: string }>();

    const rows = pending.results ?? [];
    if (rows.length === 0) break;

    // Group by DID so we resolve each PDS once per pass.
    const byDid = new Map<string, string[]>();
    for (const row of rows) {
      const cols = byDid.get(row.did) ?? [];
      cols.push(row.collection);
      byDid.set(row.did, cols);
    }

    const dids = [...byDid.keys()];
    await heartbeatBackfillRun(db, runId);

    // Warm the identity/PDS cache separately from record requests. Failures are
    // deliberately ignored here: the actual pass records them per pending row.
    for (let i = 0; i < dids.length; i += 200) {
      await Promise.allSettled(
        dids.slice(i, i + 200).map((did) =>
          getPDS(did as Did, db, config).catch(() => {})
        )
      );
    }

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

    // Fast pass: one short attempt. A DID is complete only when every pending
    // collection reaches the end of its PDS listing.
    for (let i = 0; i < dids.length; i += concurrency) {
      const batch = dids.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (did) => {
          let client: Client;
          try {
            client = await withRetry(
              () => getClient(did as Did, db, config),
              `getClient(${did})`,
              0,
              FAST_TIMEOUT
            );
          } catch {
            return { did, records: 0, completed: false };
          }

          const attempts = await Promise.all(
            byDid.get(did)!.map((collection) =>
              backfillUserAttempt(db, did, collection, Infinity, config, {
                client,
                skipReplayDetection: true,
                maxRetries: 0,
                requestTimeout: FAST_TIMEOUT,
              })
            )
          );
          return {
            did,
            records: attempts.reduce((sum, attempt) => sum + attempt.records, 0),
            completed: attempts.every((attempt) => attempt.completed),
          };
        })
      );

      for (const result of results) {
        roundBackfilled += result.records;
        if (result.completed) usersComplete++;
        else failedDids.push(result.did);
      }
      emitProgress();
      await heartbeatBackfillRun(db, runId);
    }

    // Slow retry pass: use normal timeouts and request backoff for DIDs that did
    // not finish. They remain incomplete if this pass also fails.
    const uniqueFailed = [...new Set(failedDids)];
    const retryableRows = await db
      .prepare(
        "SELECT DISTINCT did FROM backfills WHERE completed = 0 AND retries < ?"
      )
      .bind(maxAttempts)
      .all<{ did: string }>();
    const retryableDids = new Set(
      (retryableRows.results ?? []).map((row) => row.did)
    );
    const retryDids = uniqueFailed.filter((did) => retryableDids.has(did));
    usersFailed += uniqueFailed.length - retryDids.length;
    emitProgress();

    for (let i = 0; i < retryDids.length; i += concurrency) {
      const batch = retryDids.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (did) => {
          let client: Client;
          try {
            client = await withRetry(
              () => getClient(did as Did, db, config),
              `getClient(${did})`,
              2
            );
          } catch (error) {
            for (const collection of byDid.get(did)!) {
              await markFailed(db, did, collection, error);
            }
            return { records: 0, completed: false };
          }

          const attempts = await Promise.all(
            byDid.get(did)!.map((collection) =>
              backfillUserAttempt(db, did, collection, Infinity, config, {
                client,
                skipReplayDetection: true,
                maxRetries: 2,
              })
            )
          );
          return {
            records: attempts.reduce((sum, attempt) => sum + attempt.records, 0),
            completed: attempts.every((attempt) => attempt.completed),
          };
        })
      );

      for (const result of results) {
        roundBackfilled += result.records;
        if (result.completed) usersComplete++;
        else usersFailed++;
      }
      emitProgress();
      await heartbeatBackfillRun(db, runId);
    }

    totalBackfilled += roundBackfilled;
    // Do not use inserted-record count as a completion signal: a reachable PDS
    // may legitimately have zero records, while an unreachable PDS must consume
    // its bounded retry budget and remain pending.
  }

  return totalBackfilled;
}

export async function backfillPending(
  db: Database,
  config: ContrailConfig,
  options?: BackfillAllOptions
): Promise<number> {
  const runId = await tryStartBackfillRun(db);
  if (!runId) throw new Error("A backfill is already running");
  try {
    return await backfillPendingWork(db, config, options, runId);
  } finally {
    await finishBackfillRun(db, runId);
  }
}

export interface BackfillRetryOptions {
  /** Maximum accounts to attempt in one scheduled slice. Default: 5. */
  maxAccounts?: number;
  /** Total wall-clock budget for the slice. Default: 10000ms. */
  timeoutMs?: number;
  /** Deadline for each PDS request within the slice. Default: 3000ms. */
  requestTimeoutMs?: number;
}

export interface BackfillRetryResult {
  attempted: number;
  completed: number;
  failed: number;
  records: number;
  skipped: boolean;
}

/** Retry a small due slice without resetting persisted failure backoff. Safe for
 * scheduled runtimes: one database-backed run lease prevents overlap. */
export async function retryPendingBackfills(
  db: Database,
  config: ContrailConfig,
  options?: BackfillRetryOptions
): Promise<BackfillRetryResult> {
  const runId = await tryStartBackfillRun(db);
  if (!runId) {
    return { attempted: 0, completed: 0, failed: 0, records: 0, skipped: true };
  }

  const maxAccounts = positiveInteger(options?.maxAccounts, 5);
  const timeoutMs = positiveInteger(options?.timeoutMs, 10_000);
  const requestTimeoutMs = positiveInteger(options?.requestTimeoutMs, 3_000);
  const deadline = Date.now() + timeoutMs;
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let records = 0;

  try {
    const due = await db
      .prepare(
        "SELECT did FROM backfills WHERE completed = 0 AND (next_retry_at IS NULL OR next_retry_at <= ?) GROUP BY did ORDER BY MIN(COALESCE(next_retry_at, 0)), did LIMIT ?"
      )
      .bind(Date.now(), maxAccounts)
      .all<{ did: string }>();

    for (const { did } of due.results ?? []) {
      if (Date.now() >= deadline) break;
      attempted++;
      const pending = await db
        .prepare(
          "SELECT collection FROM backfills WHERE did = ? AND completed = 0 AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY collection"
        )
        .bind(did, Date.now())
        .all<{ collection: string }>();
      const collections = (pending.results ?? []).map((row) => row.collection);
      if (collections.length === 0) continue;

      let client: Client;
      try {
        client = await withRetry(
          () => getClient(did as Did, db, config),
          `getClient(${did})`,
          0,
          Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now()))
        );
      } catch (error) {
        for (const collection of collections) {
          await markFailed(db, did, collection, error);
        }
        failed++;
        await heartbeatBackfillRun(db, runId);
        continue;
      }

      const attempts: BackfillUserAttempt[] = [];
      for (const collection of collections) {
        if (Date.now() >= deadline) break;
        attempts.push(
          await backfillUserAttempt(db, did, collection, deadline, config, {
            client,
            skipReplayDetection: true,
            maxRetries: 0,
            requestTimeout: Math.min(
              requestTimeoutMs,
              Math.max(1, deadline - Date.now())
            ),
          })
        );
      }
      records += attempts.reduce((sum, attempt) => sum + attempt.records, 0);
      if (
        attempts.length === collections.length &&
        attempts.every((attempt) => attempt.completed)
      ) {
        completed++;
      } else {
        failed++;
      }
      await heartbeatBackfillRun(db, runId);
    }
  } finally {
    await finishBackfillRun(db, runId);
  }

  return { attempted, completed, failed, records, skipped: false };
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
): Promise<DiscoveryPage> {
  const url = new URL(
    `/xrpc/com.atproto.sync.listReposByCollection`,
    relay
  );
  url.searchParams.set("collection", collection);
  url.searchParams.set("limit", "1000");
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  return withRetry(
    async () => {
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = (await response.json()) as Partial<DiscoveryPage>;
      if (
        !body ||
        !Array.isArray(body.repos) ||
        !body.repos.every(
          (repo) =>
            repo && typeof repo === "object" && typeof repo.did === "string"
        ) ||
        (body.cursor !== undefined && typeof body.cursor !== "string")
      ) {
        throw new Error("Malformed discovery response");
      }
      return body as DiscoveryPage;
    },
    `fetchPage(${relay}, ${collection})`
  );
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

const DISCOVERY_RETRY_BASE_MS = 60_000;
const DISCOVERY_RETRY_MAX_MS = 60 * 60_000;

async function saveDiscoveryState(
  db: Database,
  collection: string,
  relay: string,
  cursor: string | null,
  completed: boolean
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO discovery (collection, relay, cursor, completed, retries, last_error, last_attempt_at, next_retry_at) VALUES (?, ?, ?, ?, 0, NULL, ?, NULL) ON CONFLICT(collection, relay) DO UPDATE SET cursor = excluded.cursor, completed = excluded.completed, retries = 0, last_error = NULL, last_attempt_at = excluded.last_attempt_at, next_retry_at = NULL"
    )
    .bind(collection, relay, cursor, completed ? 1 : 0, Date.now())
    .run();
}

async function markDiscoveryFailed(
  db: Database,
  collection: string,
  relay: string,
  cursor: string | null,
  retries: number,
  error: unknown
): Promise<void> {
  const now = Date.now();
  const retryDelay = Math.min(
    DISCOVERY_RETRY_BASE_MS * 2 ** Math.min(retries, 6),
    DISCOVERY_RETRY_MAX_MS
  );
  await db
    .prepare(
      "INSERT INTO discovery (collection, relay, cursor, completed, retries, last_error, last_attempt_at, next_retry_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?) ON CONFLICT(collection, relay) DO UPDATE SET cursor = excluded.cursor, completed = 0, retries = excluded.retries, last_error = excluded.last_error, last_attempt_at = excluded.last_attempt_at, next_retry_at = excluded.next_retry_at"
    )
    .bind(
      collection,
      relay,
      cursor,
      retries + 1,
      errorMessage(error),
      now,
      now + retryDelay
    )
    .run();
}

async function ensureDiscoveryRows(
  db: Database,
  collections: string[],
  relays: string[]
): Promise<void> {
  for (const collection of collections) {
    for (const relay of relays) {
      await db
        .prepare(
          "INSERT INTO discovery (collection, relay, completed) VALUES (?, ?, 0) ON CONFLICT DO NOTHING"
        )
        .bind(collection, relay)
        .run();
    }
  }
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
  await ensureDiscoveryRows(db, collections, relays);

  for (const collection of collections) {
    if (Date.now() >= deadline) break;

    let data: DiscoveryPage | null = null;
    let relay: string | null = null;

    for (const r of relays) {
      const row = await db
        .prepare(
          "SELECT cursor, completed, retries, next_retry_at FROM discovery WHERE collection = ? AND relay = ?"
        )
        .bind(collection, r)
        .first<{
          cursor: string | null;
          completed: number;
          retries: number;
          next_retry_at: number | null;
        }>();

      if (row?.completed) continue;
      if (row?.next_retry_at && row.next_retry_at > Date.now()) continue;

      try {
        data = await fetchPage(r, collection, row?.cursor ?? undefined);
        relay = r;
        break;
      } catch (error) {
        await markDiscoveryFailed(
          db,
          collection,
          r,
          row?.cursor ?? null,
          row?.retries ?? 0,
          error
        );
      }
    }
    if (!data || !relay) continue;

    const dids = data.repos.map((r) => r.did).filter(isDid);
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

export interface DiscoverAndBackfillResult {
  discovered: string[];
  backfilled: number;
}

/** Hold one lease across relay discovery and the complete initial PDS pass. */
export async function discoverAndBackfill(
  db: Database,
  config: ContrailConfig,
  options?: BackfillAllOptions,
  onDiscovered?: (count: number) => void
): Promise<DiscoverAndBackfillResult> {
  const runId = await tryStartBackfillRun(db);
  if (!runId) throw new Error("A backfill is already running");

  const allDiscovered = new Set<string>();
  try {
    while (true) {
      const dids = await discoverDIDs(db, config, Infinity);
      await heartbeatBackfillRun(db, runId);
      if (dids.length === 0) break;
      for (const did of dids) allDiscovered.add(did);
    }
    onDiscovered?.(allDiscovered.size);
    const backfilled = await backfillPendingWork(db, config, options, runId);
    return { discovered: [...allDiscovered], backfilled };
  } finally {
    await finishBackfillRun(db, runId);
  }
}
