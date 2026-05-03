import type { JetstreamSubscription } from "@atcute/jetstream";
import type { ContrailConfig, IngestEvent, Database, Logger, ResolvedContrailConfig } from "./types";
import {
  getCollectionNsids,
  getDependentNsids,
  buildFeedTargetCaps,
  resolveConfig,
  shortNameForNsid,
} from "./types";
import { initSchema, getLastCursor, saveCursor, applyEvents, pruneFeedItems } from "./db";
import { refreshStaleIdentities } from "./identity";
import { backfillFollowersFromConstellation } from "./constellation";
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
  /** Publish `collection:<nsid>` / `actor:<did>` events for each applied
   *  public record. Usually supplied by the Contrail instance. */
  pubsub?: import("./realtime/types").PubSub;
}

function getLogger(config: ContrailConfig, options?: PersistentIngestOptions): Logger {
  return options?.logger ?? config.logger ?? console;
}

export async function runPersistent(
  db: Database,
  config: ContrailConfig,
  options?: PersistentIngestOptions,
): Promise<void> {
  // Internals (applyEvents, count updates, query planning) read `_resolved`
  // and silently skip features when it's missing. The Contrail class resolves
  // in its constructor; callers using this raw export must also get a resolved
  // config, so do it defensively here. resolveConfig is idempotent.
  if (!(config as ResolvedContrailConfig)._resolved) {
    config = resolveConfig(config);
  }
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
  const dependentCollections: Set<string> = new Set(getDependentNsids(config));
  let knownDids: Set<string> | undefined;
  if (dependentCollections.size > 0) {
    const result = await db
      .prepare("SELECT did FROM identities")
      .all<{ did: string }>();
    knownDids = new Set((result.results ?? []).map((r) => r.did));
    state.cachedKnownDids = knownDids;
    log.log(`Loaded ${knownDids.size} known DIDs from database`);
  }

  const collections = getCollectionNsids(config);
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
        newlyKnownDids: new Set<string>(),
        state,
        log,
        createSubscription: options?.createSubscription,
        pubsub: options?.pubsub,
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
  /** DIDs that crossed from unknown→known during this stream's lifetime.
   *  Drained on each flush so Constellation reverse-lookups can run for them. */
  newlyKnownDids?: Set<string>;
  state: IngestState;
  log: Logger;
  createSubscription?: (cursor: number | null) => any;
  pubsub?: import("./realtime/types").PubSub;
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
  // Guards against overlap between the periodic timer flush and a main-loop
  // batchSize-driven flush. The main loop only ever awaits flush() sequentially,
  // but the setInterval callback is a second entry point on another tick.
  let flushing = false;

  const flush = async () => {
    if (buffer.length === 0 || flushing) return;
    flushing = true;
    const batch = buffer.splice(0);

    try {
      await applyEvents(db, batch, config, { pubsub: opts.pubsub });

      const lastTimeUs = Math.max(...batch.map((e) => e.time_us));
      await saveCursor(db, lastTimeUs);

      const uniqueDids = [...new Set(batch.map((e) => e.did))];
      if (uniqueDids.length > 0) {
        try {
          await refreshStaleIdentities(db, uniqueDids);
        } catch (err) {
          log.warn(`Identity refresh failed: ${err}`);
        }
      }

      // Drain newly-known DIDs and ask Constellation for back-edges.
      if (config.feeds && opts.newlyKnownDids && opts.newlyKnownDids.size > 0) {
        const drained = [...opts.newlyKnownDids];
        opts.newlyKnownDids.clear();
        for (const subj of drained) {
          try {
            await backfillFollowersFromConstellation(db, config, subj);
          } catch (err) {
            log.warn(`[constellation] subject=${subj} failed: ${err}`);
          }
        }
      }

      if (config.feeds && Date.now() - state.lastFeedPruneMs > FEED_PRUNE_INTERVAL_MS) {
        const caps = buildFeedTargetCaps(config);
        if (caps.size > 0) {
          const pruned = await pruneFeedItems(db, caps);
          if (pruned > 0) log.log(`Pruned ${pruned} old feed items`);
        }
        state.lastFeedPruneMs = Date.now();
      }

      log.log(`Flushed ${batch.length} events. Cursor: ${lastTimeUs}`);
    } finally {
      flushing = false;
    }
  };

  // Periodic flush decoupled from the main loop. Runs even when Jetstream is
  // idle, which is the whole point — without it, buffered events strand until
  // the next event or abort. Errors log and retry next interval rather than
  // propagate, so transient DB hiccups don't force a reconnect.
  const flushTimer = setInterval(() => {
    flush().catch((err) => log.error(`Timer flush failed: ${err}`));
  }, flushIntervalMs);

  const onAbort = () => {
    clearInterval(flushTimer);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const iterator = subscription[Symbol.asyncIterator]();

  try {
    while (!signal?.aborted) {
      // Per-iteration abort race so the handler can be removed synchronously
      // after the race settles — otherwise addEventListener calls accumulate on
      // the signal across the streamAndFlush lifetime.
      let abortHandler!: () => void;
      const abortPromise = new Promise<IteratorResult<any>>((resolve) => {
        abortHandler = () => resolve({ value: undefined, done: true });
        signal?.addEventListener("abort", abortHandler, { once: true });
      });

      let result: IteratorResult<any>;
      try {
        result = await Promise.race([iterator.next(), abortPromise]);
      } finally {
        signal?.removeEventListener("abort", abortHandler);
      }

      if (result.done) break;
      const event = result.value;

      if (event.kind === "commit") {
        const { commit } = event;

        if (dependentCollections.has(commit.collection) && knownDids) {
          if (!knownDids.has(event.did)) continue;
          // Subject filter: skip records whose subject DID isn't known.
          const short = shortNameForNsid(config, commit.collection);
          const subjectField = short
            ? config.collections[short]?.subjectField
            : undefined;
          if (subjectField && commit.operation !== "delete") {
            const subj = (commit.record as Record<string, unknown> | undefined)?.[
              subjectField
            ];
            if (typeof subj === "string" && !knownDids.has(subj)) continue;
          }
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
          if (!knownDids.has(event.did)) {
            knownDids.add(event.did);
            opts.newlyKnownDids?.add(event.did);
          }
        }
      }

      if (buffer.length >= batchSize) {
        await flush();
      }
    }
  } finally {
    clearInterval(flushTimer);
    signal?.removeEventListener("abort", onAbort);
    await iterator.return?.({ value: undefined, done: true });
    await flush();
  }
}
