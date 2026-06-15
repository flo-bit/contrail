import { JetstreamSubscription } from "@atcute/jetstream";
import type { ContrailConfig, IngestEvent, Database, Logger } from "./types";
import {
  getCollectionNsids,
  getDependentNsids,
  shortNameForNsid,
  buildFeedTargetCaps,
  optimizeEnabled,
  optimizeIntervalMs,
  optimizeAnalysisLimit,
} from "./types";
import { initSchema, getLastCursor, saveCursor, applyEvents, sweepFeedItems, getFeedPruneCursor, saveFeedPruneCursor, getMetaNumber, setMeta, optimizeDatabase } from "./db";
import { refreshStaleIdentities, applyIdentityEvent } from "./identity";
import { backfillFollowersFromConstellation } from "./constellation";

const BATCH_SIZE = 50;
/** Distinct actors pruned per ingest tick by the rolling feed sweep. Each
 *  actor costs a handful of index-backed O(cap) deletes, so this bounds the
 *  prune's per-tick CPU regardless of how large feed_items grows. */
export const FEED_PRUNE_SWEEP_ACTORS = 500;

/** `_contrail_meta` key for the persisted optimize cadence (so recycled cron
 *  isolates don't re-run it every tick — the in-memory-state bug we hit with
 *  the feed prune). Shared by the persistent loop. */
export const OPTIMIZE_LAST_MS_KEY = "optimize_last_ms";

/** Run the opt-in planner-stat maintenance if enabled and its persisted
 *  interval has elapsed. Bounded + no-op on Postgres (see optimizeDatabase).
 *  Wrapped by callers so a pragma-unsupported environment can't break ingest. */
export async function maybeOptimize(db: Database, config: ContrailConfig, log: Logger): Promise<void> {
  if (!optimizeEnabled(config)) return;
  const last = await getMetaNumber(db, OPTIMIZE_LAST_MS_KEY);
  if (Date.now() - (last ?? 0) <= optimizeIntervalMs(config)) return;
  // Claim the interval up front so a failing/unsupported pragma can't re-run
  // every tick — it retries only after the next interval elapses.
  await setMeta(db, OPTIMIZE_LAST_MS_KEY, String(Date.now()));
  try {
    await optimizeDatabase(db, optimizeAnalysisLimit(config));
    log.log("[maintenance] refreshed planner stats (PRAGMA optimize)");
  } catch (err) {
    log.warn(`[maintenance] optimize failed: ${err}`);
  }
}

/** Mutable state that persists across ingest cycles within the same process. */
export interface IngestState {
  cachedKnownDids?: Set<string>;
  schemaInitialized: boolean;
  /** Wall-clock of the last feed sweep — used only by the long-lived
   *  persistent loop to throttle; the recycling cron isolate sweeps every
   *  tick and relies on the persisted cursor instead. */
  lastFeedSweepMs: number;
}

export function createIngestState(): IngestState {
  return { schemaInitialized: false, lastFeedSweepMs: 0 };
}

function getLogger(config: ContrailConfig): Logger {
  return config.logger ?? console;
}

/** Sentinel returned by `nextWithDeadline` when the wait timed out. */
const INGEST_TIMEOUT = Symbol("ingest-timeout");

/** Await the iterator's next value, but give up after `ms`. Without this a
 *  quiet Jetstream (the async iterator blocks forever waiting for an event that
 *  never arrives) holds the cycle past its safety timeout until the caller's
 *  hard timeout kills the isolate — so the batch and cursor are never written. */
function nextWithDeadline<T>(
  iterator: AsyncIterator<T>,
  ms: number
): Promise<IteratorResult<T> | typeof INGEST_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout>;
  const next = iterator.next();
  // If the timeout wins this race the next() promise stays pending; swallow a
  // later rejection so it can't surface as an unhandled rejection.
  next.catch(() => {});
  const timeout = new Promise<typeof INGEST_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(INGEST_TIMEOUT), ms);
  });
  return Promise.race([next, timeout]).finally(() => clearTimeout(timer));
}

export async function ingestEvents(
  config: ContrailConfig,
  cursor: number | null,
  safetyTimeoutMs: number = 25_000,
  knownDids?: Set<string>
): Promise<{
  events: IngestEvent[];
  lastCursor: number | null;
  newlyKnownDids: string[];
  identityUpdates: Map<string, string>;
}> {
  const log = getLogger(config);
  const startTimeUs = Date.now() * 1000;
  const deadline = Date.now() + safetyTimeoutMs;
  const collected: IngestEvent[] = [];

  const collections = getCollectionNsids(config);
  const dependentCollections = new Set(getDependentNsids(config));
  const urls = config.jetstreams ?? [];

  let totalCommits = 0;
  let filteredUnknownDid = 0;
  const filteredDidSamples = new Set<string>();
  let lastYieldedTimeUs: number | null = null;
  let firstYieldedTimeUs: number | null = null;
  let connectCount = 0;
  const seenUris = new Map<string, number>(); // uri -> time_us of first occurrence
  const duplicateUris: string[] = [];
  const newlyKnownDids = new Set<string>();
  const identityUpdates = new Map<string, string>();

  const subscription = new JetstreamSubscription({
    url: urls,
    wantedCollections: collections,
    ...(cursor !== null ? { cursor } : {}),
    onConnectionOpen() {
      connectCount++;
      log.log(
        `[ingest] connected to Jetstream #${connectCount} (url=${urls.join("|")}, cursor=${cursor ?? "none"}, wanted=${collections.join(",")})`
      );
    },
    onConnectionClose(event) {
      log.log(
        `[ingest] disconnected from Jetstream: ${event.code} ${event.reason}`
      );
    },
    onConnectionError(event) {
      log.error("[ingest] Jetstream error:", event.error);
    },
  });

  const iterator = subscription[Symbol.asyncIterator]();
  type Ev = typeof subscription extends AsyncIterable<infer V> ? V : never;

  // Collect or skip a single event. Filtering uses early `return` rather than
  // the loop's `continue` so the loop's exit checks still run after a filtered
  // event (a stream of all-filtered events must not skip the deadline).
  const handleEvent = (event: Ev): void => {
    if (event.kind === "commit") {
      const { commit } = event;
      totalCommits++;

      const uri = `at://${event.did}/${commit.collection}/${commit.rkey}`;

      const short = shortNameForNsid(config, commit.collection);
      const collectionCfg = short ? config.collections[short] : undefined;

      if (dependentCollections.has(commit.collection) && knownDids) {
        if (!knownDids.has(event.did)) {
          filteredUnknownDid++;
          if (filteredDidSamples.size < 10) filteredDidSamples.add(event.did);
          return;
        }
        // Subject filter: for collections with subjectField (e.g. follows
        // pointing at a `subject` DID), drop records whose subject isn't a
        // DID we care about. Trims network-wide social graph to the
        // subjects our discoverable users overlap with.
        const subjectField = collectionCfg?.subjectField;
        if (subjectField && commit.operation !== "delete") {
          const subj = (commit.record as Record<string, unknown> | undefined)?.[
            subjectField
          ];
          if (typeof subj === "string" && !knownDids.has(subj)) {
            return;
          }
        }
      }

      if (collectionCfg?.recordFilter && commit.operation !== "delete") {
        const rec = commit.record as Record<string, unknown> | undefined;
        let keep = false;
        try {
          keep = !!(rec && collectionCfg.recordFilter(rec));
        } catch (err) {
          log.warn(`[ingest] recordFilter threw for ${uri}: ${err}`);
        }
        if (!keep) return;
      }

      const prev = seenUris.get(uri);
      if (prev !== undefined) {
        duplicateUris.push(uri);
        log.warn(
          `[ingest] DUPLICATE in cycle: ${uri} first time_us=${prev}, again=${event.time_us}, delta=${event.time_us - prev}us`
        );
      } else {
        seenUris.set(uri, event.time_us);
      }

      const now = Date.now();

      collected.push({
        uri,
        did: event.did,
        time_us: event.time_us,
        collection: commit.collection,
        operation: commit.operation as "create" | "update" | "delete",
        rkey: commit.rkey,
        cid: commit.operation === "delete" ? null : commit.cid,
        record:
          commit.operation === "delete"
            ? null
            : JSON.stringify(commit.record),
        indexed_at: now * 1000,
      });

      log.log(
        `[ingest] keep: ${commit.operation} ${uri} time_us=${event.time_us}`
      );

      if (knownDids && !dependentCollections.has(commit.collection)) {
        if (!knownDids.has(event.did)) {
          knownDids.add(event.did);
          newlyKnownDids.add(event.did);
        }
      }
    } else if (event.kind === "identity") {
      identityUpdates.set(event.did, event.identity.handle);
    }
  };

  for (;;) {
    // Run the exit checks BEFORE awaiting the next event and regardless of
    // whether the previous event was filtered — otherwise a quiet stream blocks
    // forever and an all-filtered flood never reaches the deadline check.
    if (Date.now() >= deadline) {
      log.log(
        `[ingest] safety timeout reached, stopping (deadline=${deadline}, collected=${collected.length})`
      );
      break;
    }

    const step = await nextWithDeadline(iterator, Math.max(0, deadline - Date.now()));
    if (step === INGEST_TIMEOUT) {
      log.log(
        `[ingest] safety timeout reached, stopping (deadline=${deadline}, collected=${collected.length})`
      );
      break;
    }
    if (step.done) break;
    const event = step.value;

    if (firstYieldedTimeUs === null) firstYieldedTimeUs = event.time_us;
    lastYieldedTimeUs = event.time_us;

    handleEvent(event);

    if (event.time_us >= startTimeUs) {
      log.log(
        `[ingest] caught up to present, stopping (last time_us=${event.time_us}, startTimeUs=${startTimeUs})`
      );
      break;
    }
  }

  // Close the subscription's socket, but fire-and-forget: awaiting the
  // iterator's return on a quiet stream could itself block (the hang we fix).
  Promise.resolve(iterator.return?.()).catch(() => {});

  if (filteredUnknownDid > 0) {
    const sample = [...filteredDidSamples].join(", ");
    log.log(
      `[ingest] ${filteredUnknownDid} events filtered (unknown did). sample dids: ${sample}`
    );
  }
  const lastCursor = subscription.cursor || null;

  const cursorGap =
    lastCursor !== null && lastYieldedTimeUs !== null
      ? lastCursor - lastYieldedTimeUs
      : null;

  // Detect the library's internal cursor rollback (picks a different URL → rolls
  // back 10s → first event comes in BEFORE the cursor we asked it to start from).
  const rolledBackUs =
    cursor !== null && firstYieldedTimeUs !== null && firstYieldedTimeUs < cursor
      ? cursor - firstYieldedTimeUs
      : 0;

  log.log(
    `[ingest] jetstream loop done. commits_seen=${totalCommits}, filtered=${filteredUnknownDid}, kept=${collected.length}, dupes=${duplicateUris.length}, connects=${connectCount}, first_yielded=${firstYieldedTimeUs ?? "none"}, last_yielded=${lastYieldedTimeUs ?? "none"}, subscription_cursor=${lastCursor ?? "none"}, cursor_gap=${cursorGap ?? "n/a"}us, rolled_back=${rolledBackUs}us`
  );

  if (cursorGap !== null && cursorGap > 1000) {
    log.warn(
      `[ingest] CURSOR GAP: subscription cursor is ${cursorGap}us (${Math.floor(
        cursorGap / 1000
      )}ms) ahead of last yielded event — buffered events may be dropped`
    );
  }

  if (connectCount > 1) {
    log.warn(
      `[ingest] RECONNECTED ${connectCount} times during cycle — each reconnect picks a URL at random and rolls cursor back 10s`
    );
  }

  return { events: collected, lastCursor, newlyKnownDids: [...newlyKnownDids], identityUpdates };
}

// Run a full ingest cycle: init schema, load cursor, ingest, apply, save cursor
export async function runIngestCycle(
  db: Database,
  config: ContrailConfig,
  timeoutMs: number = 25_000,
  state?: IngestState,
  pubsub?: import("./realtime/types").PubSub
): Promise<void> {
  const log = getLogger(config);
  const s = state ?? createIngestState();

  if (!s.schemaInitialized) {
    await initSchema(db, config);
    s.schemaInitialized = true;
  }

  const cursor = await getLastCursor(db);
  const collections = getCollectionNsids(config);
  const nowUs = Date.now() * 1000;
  const lagMs = cursor !== null ? Math.floor((nowUs - cursor) / 1000) : null;

  log.log(
    `[ingest] starting cycle. cursor=${cursor ?? "none"}${
      lagMs !== null ? ` (lag=${lagMs}ms)` : ""
    }, timeout=${timeoutMs}ms, collections=${collections.join(", ")}`
  );

  // Load known DIDs for filtering dependent collections
  const dependentCollections = getDependentNsids(config);
  let knownDids: Set<string> | undefined;

  if (dependentCollections.length > 0) {
    if (s.cachedKnownDids) {
      knownDids = s.cachedKnownDids;
      log.log(`Using cached known DIDs (${knownDids.size} users)`);
    } else {
      const result = await db
        .prepare("SELECT did FROM identities")
        .all<{ did: string }>();
      knownDids = new Set((result.results ?? []).map((r) => r.did));
      s.cachedKnownDids = knownDids;
      log.log(`Loaded ${knownDids.size} known DIDs from database`);
    }
  }

  const { events, lastCursor, newlyKnownDids, identityUpdates } = await ingestEvents(
    config,
    cursor,
    timeoutMs,
    knownDids
  );

  if (events.length > 0) {
    const breakdown: Record<string, number> = {};
    for (const e of events) {
      const key = `${e.collection}:${e.operation}`;
      breakdown[key] = (breakdown[key] ?? 0) + 1;
    }
    log.log(
      `[ingest] received ${events.length} events. breakdown=${JSON.stringify(breakdown)}`
    );
  } else {
    log.log(`[ingest] received 0 events from Jetstream`);
  }

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    await applyEvents(db, batch, config, { pubsub });
  }

  // Apply handle changes from #identity events. UPDATE-only, so unknown
  // DIDs are no-ops — we don't want to create partial rows lacking PDS.
  if (identityUpdates.size > 0) {
    for (const [did, handle] of identityUpdates) {
      try {
        await applyIdentityEvent(db, did, handle);
      } catch (err) {
        log.warn(`[ingest] identity update failed for ${did}: ${err}`);
      }
    }
    log.log(`[ingest] applied ${identityUpdates.size} identity event(s)`);
  }

  // Persist the cursor BEFORE the best-effort enrichment tail below. Records are
  // already durably applied (applyEvents) and handle changes recorded, so the
  // cursor's forward progress is real and must be committed now. The steps that
  // follow — refreshStaleIdentities especially — make per-DID network calls and
  // can run long; if the cron isolate is aborted (e.g. a scheduled-invocation
  // deadline) while they run, an un-saved cursor makes the next cycle re-drain the
  // identical window forever. Identity refresh is idempotent and staleness-driven,
  // so deferring it past the save costs nothing.
  if (lastCursor !== null) {
    await saveCursor(db, lastCursor);
    log.log(
      `[ingest] saved cursor=${lastCursor} (advanced ${
        cursor !== null ? lastCursor - cursor : "n/a"
      }us)`
    );
  } else {
    log.log(`[ingest] no cursor returned from subscription; not saving`);
  }

  // Refresh stale/missing identities for DIDs in this batch (best-effort; runs
  // after the cursor save so its network latency can't strand forward progress).
  const uniqueDids = [...new Set(events.map((e) => e.did))];
  if (uniqueDids.length > 0) {
    try {
      await refreshStaleIdentities(db, uniqueDids, config);
    } catch (err) {
      log.warn(`Identity refresh failed: ${err}`);
    }
  }

  // Newly-discovered DIDs: ask Constellation for back-edges so they
  // immediately appear in existing followers' feeds (best-effort, opt-out).
  if (config.feeds && newlyKnownDids.length > 0) {
    for (const subj of newlyKnownDids) {
      try {
        await backfillFollowersFromConstellation(db, config, subj);
      } catch (err) {
        log.warn(`[constellation] subject=${subj} failed: ${err}`);
      }
    }
  }

  // Prune feed_items to per-collection caps with a bounded, cursored sweep.
  // Every statement is index-backed and O(cap) (see sweepFeedItems), so it can
  // never exhaust D1's per-query CPU budget and reset the shared DO — unlike
  // the old global window+anti-join. The cron isolate recycles each tick, so we
  // persist the sweep cursor in the DB rather than gating on in-memory time,
  // and run an unconditional bounded slice every tick.
  if (config.feeds) {
    const caps = buildFeedTargetCaps(config);
    if (caps.size > 0) {
      const cursor = await getFeedPruneCursor(db);
      const { pruned, nextCursor } = await sweepFeedItems(
        db,
        caps,
        cursor,
        FEED_PRUNE_SWEEP_ACTORS
      );
      await saveFeedPruneCursor(db, nextCursor);
      if (pruned > 0) log.log(`Pruned ${pruned} feed items (sweep)`);
    }
  }

  // Opt-in planner-stat maintenance (gated + persisted cadence; no-op unless
  // config.maintenance.optimize is set).
  await maybeOptimize(db, config, log);

  log.log(`[ingest] cycle complete. stored=${events.length}`);
}
