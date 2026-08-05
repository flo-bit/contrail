import type {} from "@atcute/atproto";
import { type Did } from "@atcute/lexicons";
import { isDid, isNsid } from "@atcute/lexicons/syntax";

import type { Client } from "@atcute/client";
import type { ContrailConfig, Database, IngestEvent } from "./types";
import {
  getDiscoverableNsids,
  getDependentNsids,
  DEFAULT_RELAYS,
} from "./types";
import { getLastCursor, saveCursor } from "./db";
import { getMeta, setMeta } from "./db/meta";
import { createIngestEvent, ingestRecords, recordTimeUs } from "./ingest";
import { rebuildDerivedProjections } from "./db/records";
import { createPdsClient, getClient, getPDS } from "./client";
import {
  finishBackfillRun,
  heartbeatBackfillRun,
  tryStartBackfillRun,
} from "./status";

const PAGE_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_PDS_CONCURRENCY = 20;
const DEFAULT_DIDS_PER_PDS = 3;

const REQUEST_TIMEOUT_MS = 10_000;
const BACKFILL_RETRY_BASE_MS = 15 * 60_000;
const BACKFILL_RETRY_MAX_MS = 48 * 60 * 60_000;
const DEFAULT_SCHEDULED_MAX_ATTEMPTS = 10;
const DERIVED_PROJECTIONS_DIRTY_KEY = "backfill_derived_projections_dirty";

export interface BackfillCollectionMetrics {
  requests: number;
  pages: number;
  fetched_records: number;
  accepted_records: number;
  record_bytes: number;
  fetch_ms: number;
  projection_and_checkpoint_ms: number;
}

export interface BackfillRunMetrics {
  resolution_ms: number;
  derived_rebuild_ms: number;
  collections: Record<string, BackfillCollectionMetrics>;
}

type BackfillMetricsAccumulator = BackfillRunMetrics;

function emptyBackfillMetrics(): BackfillMetricsAccumulator {
  return {
    resolution_ms: 0,
    derived_rebuild_ms: 0,
    collections: {},
  };
}

function collectionMetrics(
  metrics: BackfillMetricsAccumulator,
  collection: string
): BackfillCollectionMetrics {
  return (metrics.collections[collection] ??= {
    requests: 0,
    pages: 0,
    fetched_records: 0,
    accepted_records: 0,
    record_bytes: 0,
    fetch_ms: 0,
    projection_and_checkpoint_ms: 0,
  });
}

function roundedMetrics(
  metrics: BackfillMetricsAccumulator
): BackfillRunMetrics {
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    resolution_ms: round(metrics.resolution_ms),
    derived_rebuild_ms: round(metrics.derived_rebuild_ms),
    collections: Object.fromEntries(
      Object.entries(metrics.collections).map(([collection, values]) => [
        collection,
        {
          ...values,
          fetch_ms: round(values.fetch_ms),
          projection_and_checkpoint_ms: round(
            values.projection_and_checkpoint_ms
          ),
        },
      ])
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  label: string,
  maxRetries = 3,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Timeout: ${label}`)),
      timeoutMs
    );
    try {
      return await fn(controller.signal);
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < maxRetries) {
      const delay = Math.min(1000 * 2 ** attempt, 10000);
      await new Promise((r) => setTimeout(r, delay));
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
  error: unknown,
  exhaustAfterAttempts?: number
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT retries, scheduled_retries FROM backfills WHERE did = ? AND collection = ?"
    )
    .bind(did, collection)
    .first<{ retries: number; scheduled_retries: number }>();
  const previousRetries = row?.retries ?? 0;
  const retries = previousRetries + 1;
  const scheduledRetries =
    (row?.scheduled_retries ?? 0) +
    (exhaustAfterAttempts === undefined ? 0 : 1);
  const now = Date.now();
  const exhausted =
    exhaustAfterAttempts !== undefined &&
    scheduledRetries >= exhaustAfterAttempts;
  const retryExponent =
    exhaustAfterAttempts === undefined
      ? 0
      : Math.max(0, scheduledRetries - (previousRetries > 0 ? 0 : 1));
  const retryDelay = Math.min(
    BACKFILL_RETRY_BASE_MS * 2 ** Math.min(retryExponent, 16),
    BACKFILL_RETRY_MAX_MS
  );
  await db
    .prepare(
      "UPDATE backfills SET retries = ?, scheduled_retries = ?, last_error = ?, last_attempt_at = ?, next_retry_at = ?, retry_exhausted = ? WHERE did = ? AND collection = ?"
    )
    .bind(
      retries,
      scheduledRetries,
      errorMessage(error),
      now,
      exhausted ? null : now + retryDelay,
      exhausted ? 1 : 0,
      did,
      collection
    )
    .run();
}

export interface BackfillOptions {
  /** Pre-resolved client — avoids redundant PDS lookups when batching by DID */
  client?: Client;
  /** Complete relay-discovered actor set for dependent-record admission. */
  knownDids?: ReadonlySet<string>;
  /** Skip replay detection during initial backfill. */
  skipReplayDetection?: boolean;
  /** Max retries per request (default: 3). Set to 0 for single-attempt mode. */
  maxRetries?: number;
  /** Per-request timeout in ms (default: 10000). */
  requestTimeout?: number;
  /** Mark the row terminal when this consecutive-failure count is reached. */
  exhaustAfterAttempts?: number;
  /** Yield after this many successful pages without consuming a retry. */
  maxPages?: number;
  /** Defer FTS and relation counts until the bulk pass finishes. */
  skipDerivedProjections?: boolean;
  /** @internal Aggregate benchmark instrumentation owned by the bulk run. */
  metrics?: BackfillMetricsAccumulator;
  /** @internal Cursor already loaded by the bulk scheduler. */
  resumeState?: { cursor: string | null };
}

interface BackfillUserAttempt {
  records: number;
  completed: boolean;
  failed: boolean;
}

async function backfillUserAttempt(
  db: Database,
  did: string,
  collection: string,
  deadline: number,
  config: ContrailConfig,
  options?: BackfillOptions
): Promise<BackfillUserAttempt> {
  if (Date.now() >= deadline) {
    return { records: 0, completed: false, failed: false };
  }

  const status = options?.resumeState
    ? {
        completed: 0,
        pds_cursor: options.resumeState.cursor,
        retries: 0,
      }
    : await db
        .prepare(
          "SELECT completed, pds_cursor, retries FROM backfills WHERE did = ? AND collection = ?"
        )
        .bind(did, collection)
        .first<{
          completed: number;
          pds_cursor: string | null;
          retries: number;
        }>();

  if (status?.completed) {
    return { records: 0, completed: true, failed: false };
  }

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
    await markFailed(
      db,
      did,
      collection,
      `Invalid DID: ${did}`,
      options?.exhaustAfterAttempts
    );
    return { records: 0, completed: false, failed: true };
  }

  if (!isNsid(collection)) {
    await markFailed(
      db,
      did,
      collection,
      `Invalid NSID: ${collection}`,
      options?.exhaustAfterAttempts
    );
    return { records: 0, completed: false, failed: true };
  }

  let client = options?.client;
  if (!client) {
    try {
      client = await withRetry(
        (signal) => getClient(did as Did, db, config, signal),
        `getClient(${did})`,
        Math.min(retries, 1),
        timeout
      );
    } catch (err) {
      await markFailed(
        db,
        did,
        collection,
        err,
        options?.exhaustAfterAttempts
      );
      return { records: 0, completed: false, failed: true };
    }
  }

  let totalInserted = 0;
  let done = false;
  let pages = 0;
  const metrics = options?.metrics
    ? collectionMetrics(options.metrics, collection)
    : undefined;

  try {
    while (Date.now() < deadline) {
      const response = await withRetry(
        async (signal) => {
          const started = performance.now();
          if (metrics) metrics.requests++;
          try {
            return await client!.get("com.atproto.repo.listRecords", {
              params: {
                repo: did as Did,
                collection,
                limit: PAGE_SIZE,
                cursor: currentCursor,
              },
              signal,
            });
          } finally {
            if (metrics) metrics.fetch_ms += performance.now() - started;
          }
        },
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
          `listRecords status ${response.status} (${detail})`,
          options?.exhaustAfterAttempts
        );
        return { records: totalInserted, completed: false, failed: true };
      }

      const records = response.data.records;
      if (metrics) {
        metrics.pages++;
        metrics.fetched_records += records.length;
      }

      const now = Date.now();
      const nowUs = now * 1000;
      const nextCursor = response.data.cursor ?? undefined;
      const pageDone = records.length === 0 || !nextCursor;
      const events: IngestEvent[] = records.map((record) =>
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
          source: {
            id: "pds-backfill",
            time_us: nowUs,
            revision: null,
            cursor: nextCursor ?? null,
          },
        }),
      );

      if (metrics) {
        metrics.record_bytes += events.reduce(
          (bytes, event) => bytes + (event.record?.length ?? 0),
          0
        );
      }
      const projectionStarted = performance.now();
      const checkpoint = db
        .prepare(
          "UPDATE backfills SET pds_cursor = ?, completed = ?, retries = 0, scheduled_retries = 0, last_error = NULL, last_attempt_at = ?, next_retry_at = NULL, retry_exhausted = 0 WHERE did = ? AND collection = ?"
        )
        .bind(nextCursor ?? null, pageDone ? 1 : 0, now, did, collection);
      const result = await ingestRecords(db, events, config, {
        skipReplayDetection: options?.skipReplayDetection,
        skipFeedFanout: true,
        knownDids: options?.knownDids,
        skipDerivedProjections: options?.skipDerivedProjections,
        // Canonical projection and cursor acknowledgement commit atomically.
        trailingStatements: [checkpoint],
        // Let sinks bulk-flush differently from live ingestion.
        phase: "backfill",
      });
      totalInserted += result.accepted.length;
      if (metrics) {
        metrics.accepted_records += result.accepted.length;
        metrics.projection_and_checkpoint_ms +=
          performance.now() - projectionStarted;
      }

      currentCursor = nextCursor;
      if (options?.resumeState) {
        options.resumeState.cursor = currentCursor ?? null;
      }
      pages++;
      if (pageDone) {
        done = true;
        break;
      }
      if (pages >= (options?.maxPages ?? Infinity)) break;
    }
  } catch (err) {
    await markFailed(
      db,
      did,
      collection,
      err,
      options?.exhaustAfterAttempts
    );
    return { records: totalInserted, completed: false, failed: true };
  }

  return { records: totalInserted, completed: done, failed: false };
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
  /** Concurrent identity resolutions before work is grouped by PDS. Default: 100. */
  concurrency?: number;
  /** PDS hosts allowed to fetch concurrently. Default: 20. */
  pdsConcurrency?: number;
  /** Accounts allowed to fetch concurrently from one PDS. Default: 3. */
  didsPerPds?: number;
  /** Per-request timeout in milliseconds. Default: 10000. */
  requestTimeoutMs?: number;
  /** Immediate attempts per failed account. Default: 1; scheduled retries handle
   * later attempts. Values above 1 are retained for explicit manual recovery. */
  maxAttempts?: number;
  onProgress?: (progress: BackfillProgress) => void;
  /** Receives aggregate source/projection timings after a complete invocation. */
  onMetrics?: (metrics: BackfillRunMetrics) => void;
}

/** Keep a fixed number of jobs active without batch barriers. Returning true
 * from consume requeues only that item, allowing paginated repositories to
 * yield fairly while completed slots refill immediately. */
async function drainQueue<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  run: (item: TItem) => Promise<TResult>,
  consume: (result: TResult) => boolean | void
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  let nextIndex = 0;
  let active = 0;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (settled) return;
      while (active < concurrency && nextIndex < queue.length) {
        const item = queue[nextIndex++];
        active++;
        run(item).then(
          (result) => {
            active--;
            if (consume(result) === true) queue.push(item);
            if (active === 0 && nextIndex >= queue.length) {
              settled = true;
              resolve();
            } else {
              pump();
            }
          },
          (error) => {
            settled = true;
            reject(error);
          }
        );
      }
    };
    pump();
  });
}

function createStreamingHostScheduler<TResult>(
  hostConcurrency: number,
  didsPerHost: number,
  run: (pds: string, did: string) => Promise<TResult>,
  consume: (result: TResult) => boolean | void
): {
  add(pds: string, did: string): void;
  finish(): Promise<void>;
} {
  type HostState = {
    pending: string[];
    active: number;
    queued: boolean;
    running: boolean;
  };
  const hosts = new Map<string, HostState>();
  const waiting: string[] = [];
  let activeHosts = 0;
  let producerDone = false;
  let settled = false;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectFinished(error);
  };

  const maybeFinish = () => {
    if (settled || !producerDone) return;
    if (activeHosts === 0 && waiting.length === 0) {
      settled = true;
      resolveFinished();
    }
  };

  const pumpHosts = () => {
    if (settled) return;
    while (activeHosts < hostConcurrency && waiting.length > 0) {
      const pds = waiting.shift()!;
      const state = hosts.get(pds)!;
      state.queued = false;
      if (state.running || state.pending.length === 0) continue;
      state.running = true;
      activeHosts++;
      pumpDids(pds, state);
    }
    maybeFinish();
  };

  const finishHost = (state: HostState) => {
    if (!state.running) return;
    state.running = false;
    activeHosts--;
    pumpHosts();
  };

  function pumpDids(pds: string, state: HostState): void {
    if (settled) return;
    while (state.active < didsPerHost && state.pending.length > 0) {
      const did = state.pending.shift()!;
      state.active++;
      run(pds, did).then(
        (result) => {
          state.active--;
          if (consume(result) === true) state.pending.push(did);
          pumpDids(pds, state);
        },
        fail
      );
    }
    if (state.active === 0 && state.pending.length === 0) {
      finishHost(state);
    }
  }

  return {
    add(pds, did) {
      if (producerDone) throw new Error("Cannot add work after scheduler finish");
      let state = hosts.get(pds);
      if (!state) {
        state = { pending: [], active: 0, queued: false, running: false };
        hosts.set(pds, state);
      }
      state.pending.push(did);
      if (state.running) {
        pumpDids(pds, state);
      } else if (!state.queued) {
        state.queued = true;
        waiting.push(pds);
        pumpHosts();
      }
    },
    finish() {
      producerDone = true;
      for (const [pds, state] of hosts) {
        if (state.running) pumpDids(pds, state);
      }
      pumpHosts();
      return finished;
    },
  };
}

async function loadKnownBackfillDids(db: Database): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT DISTINCT did FROM backfills")
    .all<{ did: string }>();
  return new Set((rows.results ?? []).map((row) => row.did));
}

async function backfillPendingWork(
  db: Database,
  config: ContrailConfig,
  options: BackfillAllOptions | undefined,
  runId: string
): Promise<number> {
  const resolutionConcurrency = positiveInteger(options?.concurrency, 100);
  const pdsConcurrency = positiveInteger(
    options?.pdsConcurrency,
    DEFAULT_PDS_CONCURRENCY
  );
  const didsPerPds = positiveInteger(
    options?.didsPerPds,
    DEFAULT_DIDS_PER_PDS
  );
  const requestTimeout = positiveInteger(
    options?.requestTimeoutMs,
    REQUEST_TIMEOUT_MS
  );
  const maxAttempts = positiveInteger(
    options?.maxAttempts,
    DEFAULT_MAX_ATTEMPTS
  );
  let totalBackfilled = 0;
  const knownDids = await loadKnownBackfillDids(db);
  const metrics = emptyBackfillMetrics();

  // Anchor the jetstream cursor to now if it hasn't been set yet, so records
  // emitted during backfill are replayed once jetstream starts.
  if ((await getLastCursor(db)) === null) {
    await saveCursor(db, Date.now() * 1000);
  }

  // Mark the set-based catch-up dirty before canonical writes. A crash can leave
  // search/count projections stale, so status stays incomplete and the next
  // manual or scheduled pass repairs them before claiming readiness.
  await setMeta(db, DERIVED_PROJECTIONS_DIRTY_KEY, "1");

  // A manual/initial run resets scheduled exhaustion, but its default one-shot
  // attempt leaves failures for cron instead of waiting on the same unhealthy
  // upstream repeatedly.
  await db
    .prepare(
      "UPDATE backfills SET retries = 0, scheduled_retries = 0, next_retry_at = NULL, retry_exhausted = 0 WHERE completed = 0"
    )
    .run();

  while (true) {
    const pending = await db
      .prepare(
        "SELECT did, collection, pds_cursor FROM backfills WHERE completed = 0 AND retries < ? ORDER BY did"
      )
      .bind(maxAttempts)
      .all<{ did: string; collection: string; pds_cursor: string | null }>();

    const rows = pending.results ?? [];
    if (rows.length === 0) break;

    type CollectionWork = {
      collection: string;
      cursor: string | null;
      completed: boolean;
      failed: boolean;
    };
    const byDid = new Map<string, CollectionWork[]>();
    for (const row of rows) {
      const collections = byDid.get(row.did) ?? [];
      collections.push({
        collection: row.collection,
        cursor: row.pds_cursor,
        completed: false,
        failed: false,
      });
      byDid.set(row.did, collections);
    }

    const dids = [...byDid.keys()];
    let roundBackfilled = 0;
    let usersComplete = 0;
    let usersFailed = 0;

    let lastHeartbeat = Date.now();
    const emitProgress = () => {
      options?.onProgress?.({
        records: totalBackfilled + roundBackfilled,
        usersComplete,
        usersTotal: dids.length,
        usersFailed,
      });
      const now = Date.now();
      if (now - lastHeartbeat >= 30_000) {
        lastHeartbeat = now;
        void heartbeatBackfillRun(db, runId).catch((error) =>
          (config.logger ?? console).warn("Backfill heartbeat failed", error)
        );
      }
    };

    await heartbeatBackfillRun(db, runId);

    // Start host work as soon as each identity resolves. This removes the
    // all-identities barrier while retaining both host and per-host limits.
    const clients = new Map<string, Client>();
    const hostScheduler = createStreamingHostScheduler(
      pdsConcurrency,
      didsPerPds,
      async (pds, did) => {
        let client = clients.get(pds);
        if (!client) {
          client = createPdsClient(pds);
          clients.set(pds, client);
        }
        const works = byDid.get(did)!;
        let records = 0;
        for (const work of works) {
          if (work.completed || work.failed) continue;
          const attempt = await backfillUserAttempt(
            db,
            did,
            work.collection,
            Infinity,
            config,
            {
              client,
              knownDids,
              skipReplayDetection: true,
              maxRetries: 0,
              requestTimeout,
              maxPages: 1,
              skipDerivedProjections: true,
              metrics,
              resumeState: work,
            }
          );
          records += attempt.records;
          work.completed = attempt.completed;
          work.failed = attempt.failed;
        }
        return {
          records,
          completed: works.every((work) => work.completed),
          failed: works.some((work) => work.failed),
        };
      },
      (result) => {
        roundBackfilled += result.records;
        if (result.completed) usersComplete++;
        else if (result.failed) usersFailed++;
        emitProgress();
        return !result.completed && !result.failed;
      }
    );

    const resolutionStarted = performance.now();
    await drainQueue(
      dids,
      resolutionConcurrency,
      async (did) => {
        try {
          const pds = await withRetry(
            (signal) => getPDS(did as Did, db, config, signal),
            `getPDS(${did})`,
            0,
            requestTimeout
          );
          if (!pds) throw new Error(`PDS not found for ${did}`);
          return { did, pds: pds.replace(/\/+$/, ""), failed: false };
        } catch (error) {
          for (const work of byDid.get(did)!) {
            await markFailed(db, did, work.collection, error);
            work.failed = true;
          }
          return { did, pds: null, failed: true };
        }
      },
      (result) => {
        if (result.pds) hostScheduler.add(result.pds, result.did);
        else if (result.failed) {
          usersFailed++;
          emitProgress();
        }
      }
    );
    metrics.resolution_ms += performance.now() - resolutionStarted;
    await hostScheduler.finish();

    totalBackfilled += roundBackfilled;
    await heartbeatBackfillRun(db, runId);
    // With the default maxAttempts=1 this ends after one failed attempt; rows
    // remain retrying with persisted backoff. Explicit larger values cause
    // another host-aware pass without changing the scheduled retry budget.
  }

  // Canonical records and cursors are durable now. Rebuild expensive derived
  // projections once with set-based SQL instead of hundreds of statements per
  // network page. This also repairs a prior interrupted bulk pass.
  const derivedStarted = performance.now();
  await rebuildDerivedProjections(db, config);
  metrics.derived_rebuild_ms += performance.now() - derivedStarted;
  await setMeta(db, DERIVED_PROJECTIONS_DIRTY_KEY, "0");
  await heartbeatBackfillRun(db, runId);
  options?.onMetrics?.(roundedMetrics(metrics));

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
  /** Failed scheduled attempts before automatic retries stop. Default: 10. */
  maxAttempts?: number;
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
  const maxAttempts = positiveInteger(
    options?.maxAttempts,
    DEFAULT_SCHEDULED_MAX_ATTEMPTS
  );
  const timeoutMs = positiveInteger(options?.timeoutMs, 10_000);
  const requestTimeoutMs = positiveInteger(options?.requestTimeoutMs, 3_000);
  const deadline = Date.now() + timeoutMs;
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let records = 0;

  try {
    if ((await getMeta(db, DERIVED_PROJECTIONS_DIRTY_KEY)) === "1") {
      await rebuildDerivedProjections(db, config);
      await setMeta(db, DERIVED_PROJECTIONS_DIRTY_KEY, "0");
      await heartbeatBackfillRun(db, runId);
    }

    const knownDids = await loadKnownBackfillDids(db);
    const due = await db
      .prepare(
        "SELECT did FROM backfills WHERE completed = 0 AND retry_exhausted = 0 AND (next_retry_at IS NULL OR next_retry_at <= ?) GROUP BY did ORDER BY MIN(COALESCE(next_retry_at, 0)), did LIMIT ?"
      )
      .bind(Date.now(), maxAccounts)
      .all<{ did: string }>();

    for (const { did } of due.results ?? []) {
      if (Date.now() >= deadline) break;
      attempted++;
      const pending = await db
        .prepare(
          "SELECT collection FROM backfills WHERE did = ? AND completed = 0 AND retry_exhausted = 0 AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY collection"
        )
        .bind(did, Date.now())
        .all<{ collection: string }>();
      const collections = (pending.results ?? []).map((row) => row.collection);
      if (collections.length === 0) continue;

      let client: Client;
      try {
        client = await withRetry(
          (signal) => getClient(did as Did, db, config, signal),
          `getClient(${did})`,
          0,
          Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now()))
        );
      } catch (error) {
        for (const collection of collections) {
          await markFailed(
            db,
            did,
            collection,
            error,
            maxAttempts
          );
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
            knownDids,
            skipReplayDetection: true,
            maxRetries: 0,
            requestTimeout: Math.min(
              requestTimeoutMs,
              Math.max(1, deadline - Date.now())
            ),
            exhaustAfterAttempts: maxAttempts,
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
    async (signal) => {
      const response = await fetch(url.toString(), { signal });
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
