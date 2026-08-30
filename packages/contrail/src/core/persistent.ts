import {
  JetstreamLiveHistoryExpiredError,
  JetstreamLiveSubscription,
  type JetstreamLiveEvent,
} from "./jetstream-live";
import type { ContrailConfig, IngestEvent, Database, Logger, ResolvedContrailConfig } from "./types";
import {
  getCollectionNsids,
  getDependentNsids,
  buildFeedTargetCaps,
  getFeedMutatingNsids,
  jetstreamService,
  resolveConfig,
} from "./types";
import { assertJetstreamServiceCompatibility, assertServingSourceCompatibility, initSchema, getLastCursor, loadKnownActorDids, saveJetstreamCursorStatement, saveJetstreamCursorObservationStatements, saveOrderedSourcePositionStatement } from "./db";
import { createIngestEvent, ingestRecords, recordTimeUs } from "./ingest";
import { refreshStaleIdentities, applyIdentityEvent } from "./identity";
import { backfillFollowersFromConstellation } from "./constellation";
import {
  createIngestState,
  runFeedPruneSlice,
  FEED_PRUNE_RECOVERY_INTERVAL_MS,
  maybeOptimize,
} from "./jetstream";
import type { IngestState } from "./jetstream";

/** How often the long-lived persistent loop runs a bounded feed sweep. The
 *  process stays resident, so this in-memory throttle is reliable here (unlike
 *  the recycling cron isolate). */
const FEED_SWEEP_INTERVAL_MS = 10_000;

export interface PersistentJetstreamSubscription
  extends AsyncIterable<JetstreamLiveEvent> {
  /** Effective initial source coordinate, when the transport exposes one. */
  cursor?: number | null;
}

export interface PersistentIngestOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  signal?: AbortSignal;
  /** Override subscription creation for testing or a custom transport. */
  createSubscription?: (
    cursor: number | null,
    signal?: AbortSignal,
  ) => PersistentJetstreamSubscription;
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
  // Ingestion, count updates, and query planning read `_resolved`
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
  const service = jetstreamService(config.jetstreams ?? []);

  // Init schema once
  if (!state.schemaInitialized) {
    await initSchema(db, config);
    state.schemaInitialized = true;
  }
  await assertServingSourceCompatibility(db, config.orderedSource);
  await assertJetstreamServiceCompatibility(db, service);

  // Load known DIDs for dependent collection filtering
  const dependentCollections: Set<string> = new Set(getDependentNsids(config));
  let knownDids: Set<string> | undefined;
  if (dependentCollections.size > 0) {
    knownDids = await loadKnownActorDids(db, config);
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
        knownDids,
        newlyKnownDids: new Set<string>(),
        state,
        log,
        service,
        createSubscription: options?.createSubscription,
      });
      reconnectAttempts = 0;
    } catch (err) {
      if (signal?.aborted) break;
      if (err instanceof JetstreamLiveHistoryExpiredError) throw err;
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
  service: string;
  collections: string[];
  knownDids?: Set<string>;
  /** DIDs that crossed from unknown→known during this stream's lifetime.
   *  Drained on each flush so Constellation reverse-lookups can run for them. */
  newlyKnownDids?: Set<string>;
  state: IngestState;
  log: Logger;
  createSubscription?: PersistentIngestOptions["createSubscription"];
}

async function streamAndFlush(
  db: Database,
  config: ContrailConfig,
  cursor: number | null,
  opts: StreamOptions,
): Promise<void> {
  const { batchSize, flushIntervalMs, signal, collections, knownDids, state, log } = opts;

  const subscription = opts.createSubscription
    ? opts.createSubscription(cursor, signal)
    : new JetstreamLiveSubscription({
        url: opts.service,
        wantedCollections: collections,
        ...(cursor !== null ? { cursor } : {}),
        signal,
        onConnectionOpen() { log.log("Connected to Jetstream v2"); },
        onConnectionClose(event) { log.log(`Disconnected: ${event.code ?? ""} ${event.reason ?? ""}`); },
        onConnectionError(event) { log.error("Jetstream v2 error:", event.error); },
      });

  // A fresh v2 subscription begins from a timestamp-domain overlap bridge.
  // Persist that exact lower bound before the first pull so failed connection
  // attempts cannot create progressively newer bridges and skip the outage.
  const initialCursor = cursor === null ? subscription.cursor : null;
  if (initialCursor !== null && initialCursor !== undefined) {
    if (!Number.isSafeInteger(initialCursor) || initialCursor < 0) {
      throw new TypeError(
        "persistent Jetstream subscription cursor must be a non-negative safe integer",
      );
    }
    await db.batch([
      saveJetstreamCursorStatement(db, initialCursor),
      ...(config.orderedSource
        ? [
            saveOrderedSourcePositionStatement(
              db,
              config.orderedSource,
              initialCursor,
            ),
          ]
        : []),
      ...saveJetstreamCursorObservationStatements(db, initialCursor, []),
    ]);
  }

  const buffer: IngestEvent[] = [];
  // Highest fully handled v2 seq not yet committed. This includes identity
  // events, so a commit-quiet stream still advances and does not replay global
  // identity traffic forever after restart.
  let pendingCursor: number | null = null;
  // Guards against overlap between the periodic timer flush and a main-loop
  // batchSize-driven flush. The main loop only ever awaits flush() sequentially,
  // but the setInterval callback is a second entry point on another tick.
  let flushing = false;

  const flush = async () => {
    if (flushing) return;
    flushing = true;

    try {
      const checkpoint = pendingCursor;
      if (checkpoint !== null) pendingCursor = null;
      if (buffer.length > 0) {
        const batch = buffer.splice(0);
        const lastCursor = Math.max(
          checkpoint ?? 0,
          ...batch.map((event) => Number(event.source?.cursor)),
        );
        let ingestResult: Awaited<ReturnType<typeof ingestRecords>>;
        try {
          ingestResult = await ingestRecords(db, batch, config, {
            phase: "live",
            knownDids,
            trailingStatements: [
              saveJetstreamCursorStatement(db, lastCursor),
              ...(config.orderedSource
                ? [
                    saveOrderedSourcePositionStatement(
                      db,
                      config.orderedSource,
                      lastCursor,
                    ),
                  ]
                : []),
              ...saveJetstreamCursorObservationStatements(db, lastCursor, []),
            ],
          });
        } catch (error) {
          // The cursor transaction failed, so keep this exact batch at the front
          // for the timer's next attempt rather than losing it in memory.
          buffer.unshift(...batch);
          pendingCursor = Math.max(pendingCursor ?? 0, lastCursor);
          throw error;
        }
        const { accepted, discoveredDids } = ingestResult;

        if (knownDids) {
          for (const did of discoveredDids) {
            knownDids.add(did);
            opts.newlyKnownDids?.add(did);
          }
        }

        // A feed can only go over cap right after a feed-mutating record is
        // applied, so remember whether this batch had one. The sweep below uses
        // it to prune promptly (see the cron path in jetstream.ts).
        if (config.feeds) {
          const feedMutatingNsids = getFeedMutatingNsids(config);
          if (accepted.some((e) => feedMutatingNsids.has(e.collection))) {
            state.feedDirty = true;
          }
        }

        const uniqueDids = [...new Set(accepted.map((e) => e.did))];
        if (uniqueDids.length > 0) {
          try {
            await refreshStaleIdentities(db, uniqueDids, config);
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

        // Opt-in planner-stat maintenance (gated + persisted cadence).
        await maybeOptimize(db, config, log);

        log.log(
          `Flushed ${accepted.length}/${batch.length} records. Cursor: ${lastCursor}`,
        );
      } else if (checkpoint !== null) {
        try {
          await db.batch([
            saveJetstreamCursorStatement(db, checkpoint),
            ...(config.orderedSource
              ? [
                  saveOrderedSourcePositionStatement(
                    db,
                    config.orderedSource,
                    checkpoint,
                  ),
                ]
              : []),
            ...saveJetstreamCursorObservationStatements(db, checkpoint, []),
          ]);
        } catch (error) {
          pendingCursor = Math.max(pendingCursor ?? 0, checkpoint);
          throw error;
        }
      }

      // Bounded, cursored feed prune (see sweepFeedItems / runFeedPruneSlice).
      // Runs whether or not this tick had events: ingest-dirty windows prune
      // promptly (throttled by the sweep interval), and the recovery interval
      // still fires on a fully idle stream — the timer drives this flush, and
      // the old "return early when the buffer is empty" path starved recovery,
      // so over-cap rows from a lowered cap or a bulk import never drained while
      // the stream was quiet. The recovery clock tracks the last *completed*
      // full pass (not the last slice), so an overdue pass keeps slicing each
      // tick until the cursor wraps rather than advancing one slice per interval.
      if (config.feeds) {
        const caps = buildFeedTargetCaps(config);
        if (caps.size > 0) {
          const now = Date.now();
          const dirtyDue =
            state.feedDirty && now - state.lastFeedSweepMs > FEED_SWEEP_INTERVAL_MS;
          const recoveryDue =
            now - state.lastFullFeedPassMs > FEED_PRUNE_RECOVERY_INTERVAL_MS;
          if (dirtyDue || recoveryDue) {
            const { pruned, done } = await runFeedPruneSlice(db, config);
            if (done) state.lastFullFeedPassMs = now;
            if (dirtyDue) {
              state.feedDirty = false;
              state.lastFeedSweepMs = now;
            }
            if (pruned > 0) {
              log.log(
                `Pruned ${pruned} feed items (sweep, reason=${dirtyDue ? "ingest" : "recovery"})`
              );
            }
          }
        }
      }
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

        buffer.push(
          createIngestEvent({
            did: event.did,
            timeUs:
              commit.operation === "delete"
                ? event.time_us
                : recordTimeUs(
                    commit.record,
                    commit.collection,
                    config,
                    event.time_us,
                  ),
            collection: commit.collection,
            operation: commit.operation,
            rkey: commit.rkey,
            cid: commit.operation === "delete" ? null : commit.cid,
            value: commit.operation === "delete" ? undefined : commit.record,
            source: {
              id: config.orderedSource?.source ?? "jetstream",
              ...(config.orderedSource
                ? { epoch: config.orderedSource.epoch }
                : {}),
              time_us: event.time_us,
              revision: commit.rev,
              cursor: String(event.seq),
            },
          }),
        );

      } else if (
        event.kind === "identity" &&
        event.identity.handle !== undefined
      ) {
        try {
          await applyIdentityEvent(db, event.did, event.identity.handle);
        } catch (err) {
          log.warn(`Identity update failed for ${event.did}: ${err}`);
        }
      }

      pendingCursor = Math.max(pendingCursor ?? 0, event.seq);

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
