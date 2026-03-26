import type { JetstreamSubscription } from "@atcute/jetstream";
import type { ContrailConfig, IngestEvent, Database, Logger } from "./types";
import { getCollectionNames, getDependentCollections, DEFAULT_FEED_MAX_ITEMS } from "./types";
import { initSchema, getLastCursor, saveCursor, applyEvents, pruneFeedItems } from "./db";
import { refreshStaleIdentities } from "./identity";
import { createIngestState } from "./jetstream";
import type { IngestState } from "./jetstream";

const FEED_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface PersistentIngestOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  signal?: AbortSignal;
  /** Override subscription creation for testing */
  createSubscription?: (cursor: number | null) => JetstreamSubscription;
  logger?: Logger;
}

function getLogger(config: ContrailConfig, options?: PersistentIngestOptions): Logger {
  return options?.logger ?? config.logger ?? console;
}

export async function runPersistent(
  db: Database,
  config: ContrailConfig,
  options?: PersistentIngestOptions,
): Promise<void> {
  const log = getLogger(config, options);
  const batchSize = options?.batchSize ?? 50;
  const flushIntervalMs = options?.flushIntervalMs ?? 5_000;
  const signal = options?.signal;
  const state = createIngestState();

  // Init schema once
  if (!state.schemaInitialized) {
    await initSchema(db, config);
    state.schemaInitialized = true;
  }

  // Load known DIDs for dependent collection filtering
  const dependentCollections = new Set(getDependentCollections(config));
  let knownDids: Set<string> | undefined;
  if (dependentCollections.size > 0) {
    const result = await db
      .prepare("SELECT did FROM identities")
      .all<{ did: string }>();
    knownDids = new Set((result.results ?? []).map((r) => r.did));
    state.cachedKnownDids = knownDids;
    log.log(`Loaded ${knownDids.size} known DIDs from database`);
  }

  const collections = getCollectionNames(config);
  let reconnectAttempts = 0;

  while (!signal?.aborted) {
    const cursor = await getLastCursor(db);
    log.log(`Starting persistent ingestion. Cursor: ${cursor ?? "none"}, Collections: ${collections.join(", ")}`);

    try {
      await streamAndFlush(db, config, cursor, {
        batchSize,
        flushIntervalMs,
        signal,
        collections,
        dependentCollections,
        knownDids,
        state,
        log,
        createSubscription: options?.createSubscription,
      });
      reconnectAttempts = 0;
    } catch (err) {
      if (signal?.aborted) break;
      log.error(`Jetstream connection error: ${err}`);
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000);
      reconnectAttempts++;
      log.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  log.log("Persistent ingestion stopped");
}

interface StreamOptions {
  batchSize: number;
  flushIntervalMs: number;
  signal?: AbortSignal;
  collections: string[];
  dependentCollections: Set<string>;
  knownDids?: Set<string>;
  state: IngestState;
  log: Logger;
  createSubscription?: (cursor: number | null) => any;
}

async function streamAndFlush(
  db: Database,
  config: ContrailConfig,
  cursor: number | null,
  opts: StreamOptions,
): Promise<void> {
  const { batchSize, flushIntervalMs, signal, collections, dependentCollections, knownDids, state, log } = opts;

  const subscription = opts.createSubscription
    ? opts.createSubscription(cursor)
    : new (await import("@atcute/jetstream")).JetstreamSubscription({
        url: config.jetstreams ?? [],
        wantedCollections: collections,
        ...(cursor !== null ? { cursor } : {}),
        onConnectionOpen() { log.log("Connected to Jetstream"); },
        onConnectionClose(event: any) { log.log(`Disconnected: ${event.code} ${event.reason}`); },
        onConnectionError(event: any) { log.error("Jetstream error:", event.error); },
      });

  const buffer: IngestEvent[] = [];
  let flushDue = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const resetFlushTimer = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushDue = true; }, flushIntervalMs);
  };

  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    flushDue = false;
    resetFlushTimer();

    await applyEvents(db, batch, config);

    const lastTimeUs = Math.max(...batch.map((e) => e.time_us));
    await saveCursor(db, lastTimeUs);

    // Identity refresh
    const uniqueDids = [...new Set(batch.map((e) => e.did))];
    if (uniqueDids.length > 0) {
      try {
        await refreshStaleIdentities(db, uniqueDids);
      } catch (err) {
        log.warn(`Identity refresh failed: ${err}`);
      }
    }

    // Feed pruning
    if (config.feeds && Date.now() - state.lastFeedPruneMs > FEED_PRUNE_INTERVAL_MS) {
      const maxItems = Math.max(
        ...Object.values(config.feeds).map((f) => f.maxItems ?? DEFAULT_FEED_MAX_ITEMS)
      );
      const pruned = await pruneFeedItems(db, maxItems);
      if (pruned > 0) log.log(`Pruned ${pruned} old feed items`);
      state.lastFeedPruneMs = Date.now();
    }

    log.log(`Flushed ${batch.length} events. Cursor: ${lastTimeUs}`);
  };

  // Handle abort
  const onAbort = () => {
    if (flushTimer) clearTimeout(flushTimer);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  resetFlushTimer();

  // Use manual iterator so we can race next() against abort signal
  const iterator = subscription[Symbol.asyncIterator]();

  try {
    while (true) {
      if (signal?.aborted) break;

      // Race the next event against abort signal
      let result: IteratorResult<any>;
      if (signal) {
        const abortPromise = new Promise<IteratorResult<any>>((resolve) => {
          const handler = () => resolve({ value: undefined, done: true });
          signal.addEventListener("abort", handler, { once: true });
        });
        result = await Promise.race([iterator.next(), abortPromise]);
      } else {
        result = await iterator.next();
      }

      if (result.done) break;
      const event = result.value;

      if (event.kind === "commit") {
        const { commit } = event;

        if (dependentCollections.has(commit.collection) && knownDids) {
          if (!knownDids.has(event.did)) continue;
        }

        const now = Date.now();
        const uri = `at://${event.did}/${commit.collection}/${commit.rkey}`;

        buffer.push({
          uri,
          did: event.did,
          time_us: event.time_us,
          collection: commit.collection,
          operation: commit.operation as "create" | "update" | "delete",
          rkey: commit.rkey,
          cid: commit.operation === "delete" ? null : commit.cid,
          record: commit.operation === "delete" ? null : JSON.stringify(commit.record),
          indexed_at: now * 1000,
        });

        if (knownDids && !dependentCollections.has(commit.collection)) {
          knownDids.add(event.did);
        }
      }

      if (buffer.length >= batchSize || flushDue) {
        await flush();
      }
    }
  } finally {
    // Clean up iterator
    await iterator.return?.({ value: undefined, done: true });
    // Final flush on exit
    await flush();
    signal?.removeEventListener("abort", onAbort);
  }
}
