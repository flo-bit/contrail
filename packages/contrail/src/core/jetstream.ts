import { JetstreamSubscription } from "@atcute/jetstream";
import type { ContrailConfig, IngestEvent, Database, Logger } from "./types";
import { getCollectionNsids, getDependentNsids, DEFAULT_FEED_MAX_ITEMS } from "./types";
import { initSchema, getLastCursor, saveCursor, applyEvents, pruneFeedItems } from "./db";
import { refreshStaleIdentities } from "./identity";

const BATCH_SIZE = 50;
const FEED_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Mutable state that persists across ingest cycles within the same process. */
export interface IngestState {
  cachedKnownDids?: Set<string>;
  schemaInitialized: boolean;
  lastFeedPruneMs: number;
}

export function createIngestState(): IngestState {
  return { schemaInitialized: false, lastFeedPruneMs: 0 };
}

function getLogger(config: ContrailConfig): Logger {
  return config.logger ?? console;
}

export async function ingestEvents(
  config: ContrailConfig,
  cursor: number | null,
  safetyTimeoutMs: number = 25_000,
  knownDids?: Set<string>
): Promise<{ events: IngestEvent[]; lastCursor: number | null }> {
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

  for await (const event of subscription) {
    if (firstYieldedTimeUs === null) firstYieldedTimeUs = event.time_us;
    lastYieldedTimeUs = event.time_us;
    if (event.kind === "commit") {
      const { commit } = event;
      totalCommits++;

      const uri = `at://${event.did}/${commit.collection}/${commit.rkey}`;

      if (dependentCollections.has(commit.collection) && knownDids) {
        if (!knownDids.has(event.did)) {
          filteredUnknownDid++;
          if (filteredDidSamples.size < 10) filteredDidSamples.add(event.did);
          continue;
        }
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
        knownDids.add(event.did);
      }
    }

    if (event.time_us >= startTimeUs) {
      log.log(
        `[ingest] caught up to present, stopping (last time_us=${event.time_us}, startTimeUs=${startTimeUs})`
      );
      break;
    }

    if (Date.now() >= deadline) {
      log.log(
        `[ingest] safety timeout reached, stopping (deadline=${deadline}, collected=${collected.length})`
      );
      break;
    }
  }

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

  return { events: collected, lastCursor };
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

  const { events, lastCursor } = await ingestEvents(
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

  // Refresh stale/missing identities for DIDs in this batch
  const uniqueDids = [...new Set(events.map((e) => e.did))];
  if (uniqueDids.length > 0) {
    try {
      await refreshStaleIdentities(db, uniqueDids);
    } catch (err) {
      log.warn(`Identity refresh failed: ${err}`);
    }
  }

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

  // Prune feed items hourly
  if (config.feeds && Date.now() - s.lastFeedPruneMs > FEED_PRUNE_INTERVAL_MS) {
    const maxItems = Math.max(
      ...Object.values(config.feeds).map((f) => f.maxItems ?? DEFAULT_FEED_MAX_ITEMS)
    );
    const pruned = await pruneFeedItems(db, maxItems);
    if (pruned > 0) log.log(`Pruned ${pruned} old feed items`);
    s.lastFeedPruneMs = Date.now();
  }

  log.log(`[ingest] cycle complete. stored=${events.length}`);
}
