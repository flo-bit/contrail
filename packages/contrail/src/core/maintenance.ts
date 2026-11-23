import type { ContrailConfig, Database, IngestEvent, Logger } from "./types";
import {
  buildFeedTargetCaps,
  optimizeAnalysisLimit,
  optimizeEnabled,
  optimizeIntervalMs,
} from "./types";
import {
  getFeedPruneCursor,
  getMetaNumber,
  optimizeDatabase,
  pruneGrownFeeds,
  saveFeedPruneCursor,
  setMeta,
  sweepFeedItems,
} from "./db";

/** Distinct actors pruned per ingest tick by the rolling feed sweep. Each
 *  actor costs a handful of index-backed O(cap) deletes, so this bounds the
 *  prune's per-tick CPU regardless of how large feed_items grows. */
export const FEED_PRUNE_SWEEP_ACTORS = 500;

/** How long after a completed full pass the recovery sweep becomes due again,
 *  even when no feed-relevant records are ingested, so over-cap rows that
 *  predate a config change (e.g. a lowered cap) or a bulk import still drain.
 *  Once due, the pass advances one slice per tick, so a full pass *completes*
 *  roughly every (this interval + lap time), where lap time is
 *  ceil(actors / FEED_PRUNE_SWEEP_ACTORS) ticks. Steady-state pruning is driven
 *  by ingest; this is only the safety net. */
export const FEED_PRUNE_RECOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/** `_contrail_meta` key for the wall-clock (ms) at which the rolling feed sweep
 *  last *completed a full pass* over every actor, so a recycled cron isolate can
 *  honor the recovery interval across ticks. Tracking pass completion (not the
 *  last slice) is what keeps the recovery interval measuring from a real drain
 *  rather than from one bounded slice — without it, a single slice resets the
 *  clock and a feed touched just after the cursor passed it could wait many
 *  intervals to be revisited. */
const FEED_PRUNE_LAST_FULL_PASS_META = "feed_prune_last_full_pass_ms";

/** `_contrail_meta` key for the persisted optimize cadence (so recycled cron
 *  isolates don't re-run it every tick — the in-memory-state bug we hit with
 *  the feed prune). Shared by the persistent loop. */
export const OPTIMIZE_LAST_MS_KEY = "optimize_last_ms";

function getLogger(config: ContrailConfig): Logger {
  return config.logger ?? console;
}

/** Run the opt-in planner-stat maintenance if enabled and its persisted
 *  interval has elapsed. Bounded + no-op on Postgres (see optimizeDatabase).
 *  Wrapped by callers so a pragma-unsupported environment can't break ingest. */
export async function maybeOptimize(
  db: Database,
  config: ContrailConfig,
  log: Logger,
): Promise<void> {
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

/** One bounded feed-prune slice: advances the persisted rolling cursor by up to
 *  {@link FEED_PRUNE_SWEEP_ACTORS} actors and reports whether the slice reached
 *  the end of the actor list (i.e. a full pass just completed and the cursor
 *  wrapped). Callers decide WHEN to sweep (ingest-dirty vs recovery); this owns
 *  the slice + cursor mechanics so the cron loop, the persistent loop, and the
 *  notify path all prune identically. No-op (done) when no feed caps apply. */
export async function runFeedPruneSlice(
  db: Database,
  config: ContrailConfig,
): Promise<{ pruned: number; done: boolean }> {
  const caps = buildFeedTargetCaps(config);
  if (caps.size === 0) return { pruned: 0, done: true };
  const cursor = await getFeedPruneCursor(db);
  const { pruned, nextCursor, done } = await sweepFeedItems(
    db,
    caps,
    cursor,
    FEED_PRUNE_SWEEP_ACTORS,
  );
  await saveFeedPruneCursor(db, nextCursor);
  return { pruned, done };
}

/** Prune the feeds an applied batch grew (see pruneGrownFeeds), within the
 *  statement budget of one sweep slice: {@link FEED_PRUNE_SWEEP_ACTORS} actors
 *  times each capped collection. Returns true when the batch's fan-out
 *  overflowed that budget, which the caller answers with a sweep slice. No
 *  queries at all for a batch that grew no feed. */
export async function runGrownFeedPrune(
  db: Database,
  config: ContrailConfig,
  applied: readonly IngestEvent[],
): Promise<boolean> {
  const caps = buildFeedTargetCaps(config);
  if (caps.size === 0) return false;
  const { pruned, overflow } = await pruneGrownFeeds(
    db,
    config,
    applied,
    FEED_PRUNE_SWEEP_ACTORS * caps.size,
  );
  if (pruned > 0) {
    getLogger(config).log(`Pruned ${pruned} feed items (grown feeds)`);
  }
  return overflow;
}

/** Prune after an ingest batch against the *persisted* recovery clock — shared
 *  by the recycling cron isolate and the stateless `notifyOfUpdate` path (the
 *  long-lived persistent loop uses its in-memory clocks instead).
 *
 *  The feeds `applied` grew are pruned directly ({@link runGrownFeedPrune}). A
 *  sweep slice runs only when a full pass is overdue or the batch's fan-out
 *  overflowed the grown-feed budget. It records pass completion so the recovery
 *  clock measures from a real drain (one slice per tick until the cursor wraps)
 *  rather than resetting on a single slice. The recovery pass remains the
 *  safety net for anything the grown-feed prune doesn't see: a lowered cap, a
 *  bulk import, a follower past the budget, a failed Constellation backfill, an
 *  ingest path that doesn't prune. No-op when feeds are unconfigured. */
export async function runGatedFeedPrune(
  db: Database,
  config: ContrailConfig,
  applied: readonly IngestEvent[],
): Promise<void> {
  if (!config.feeds) return;
  if (buildFeedTargetCaps(config).size === 0) return;
  const overflow = await runGrownFeedPrune(db, config, applied);
  const nowMs = Date.now();
  const lastFullPassMs =
    (await getMetaNumber(db, FEED_PRUNE_LAST_FULL_PASS_META)) ?? 0;
  const recoveryDue = nowMs - lastFullPassMs >= FEED_PRUNE_RECOVERY_INTERVAL_MS;
  if (!overflow && !recoveryDue) return;
  const { pruned, done } = await runFeedPruneSlice(db, config);
  if (done) await setMeta(db, FEED_PRUNE_LAST_FULL_PASS_META, String(nowMs));
  if (pruned > 0) {
    const reason = overflow ? "overflow" : "recovery";
    getLogger(config).log(
      `Pruned ${pruned} feed items (sweep, reason=${reason})`,
    );
  }
}
