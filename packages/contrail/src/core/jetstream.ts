import { JetstreamSubscription } from "@atcute/jetstream";
import type { ContrailConfig, IngestEvent, Database, Logger } from "./types";
import {
  DEFAULT_JETSTREAMS,
  getCollectionNsids,
  getDependentNsids,
  jetstreamUrlOption,
  buildFeedTargetCaps,
  getFeedMutatingNsids,
  optimizeEnabled,
  optimizeIntervalMs,
  optimizeAnalysisLimit,
} from "./types";
import { initSchema, getLastCursor, saveCursor, saveCursorStatement, getCursorObservations, saveCursorObservationStatements, saveOrderedSourcePositionStatement, sweepFeedItems, getFeedPruneCursor, saveFeedPruneCursor, getMetaNumber, setMeta, optimizeDatabase } from "./db";
import {
  createIngestEvent,
  ingestRecords,
  recordTimeUs,
  type IngestDropCounts,
  type IngestWarningSamples,
} from "./ingest";
import { refreshStaleIdentities, applyIdentityEvent } from "./identity";
import { backfillFollowersFromConstellation } from "./constellation";

const BATCH_SIZE = 50;

/** Fixed estimate for the URI, source position, revision, CID, and other
 * metadata retained beside each serialized record body. Deletes consume only
 * this allowance. The byte budget is intentionally an admission threshold: the
 * candidate that reaches it is retained, bounding overshoot to one record plus
 * this allowance. */
export const SCHEDULED_INGEST_METADATA_BYTES = 512;

/** Conservative defaults for one D1/Worker scheduled drain. Persistent
 * ingestion has its own streaming lifecycle and does not use these limits. */
export const DEFAULT_SCHEDULED_INGEST_BUDGET = Object.freeze({
  maxDrainMs: 25_000,
  maxCandidates: 250,
  maxSerializedBytes: 4 * 1024 * 1024,
}) satisfies ScheduledIngestBudget;

export interface ScheduledIngestBudget {
  maxDrainMs: number;
  maxCandidates: number;
  maxSerializedBytes: number;
}

export interface ScheduledIngestOptions {
  /** Maximum wall time spent requesting source items. Default: 25 seconds. */
  maxDrainMs?: number;
  /** Maximum unique commit candidates retained by one drain. Default: 250. */
  maxCandidates?: number;
  /** UTF-8 record bytes plus metadata allowances. Default: 4 MiB. */
  maxSerializedBytes?: number;
  /** @deprecated Compatibility alias for maxDrainMs. */
  timeoutMs?: number;
}

export type ScheduledIngestStopReason =
  | "head"
  | "idle"
  | "count"
  | "bytes"
  | "drain-time"
  | "cancelled";

export interface ScheduledIngestCollectionStats {
  observedSourceItems: number;
  commitObservations: number;
  identityObservations: number;
  retainedCandidates: number;
  exactDuplicatesDropped: number;
  cursorBoundaryDuplicatesDropped: number;
  resumeOverlapDropped: number;
  sourceScopeFiltered: number;
  sourceInconsistencies: number;
  serializedCandidateBytes: number;
  startingCursor: number | null;
  lastAccountedCursor: number | null;
  safeEndingCursor: number | null;
  stopReason: ScheduledIngestStopReason;
  connections: number;
  connectionCloses: number;
  connectionErrors: number;
  diagnosticSamples: string[];
  diagnosticSamplesOmitted: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite integer`);
  }
  return value;
}

/** Resolve and validate every scheduled collection threshold. */
export function resolveScheduledIngestBudget(
  value?: ScheduledIngestOptions | ScheduledIngestBudget | number,
): ScheduledIngestBudget {
  if (typeof value === "number") {
    return {
      ...DEFAULT_SCHEDULED_INGEST_BUDGET,
      maxDrainMs: positiveInteger(value, "maxDrainMs"),
    };
  }
  const options = (value ?? {}) as ScheduledIngestOptions;
  if (options.timeoutMs !== undefined) {
    positiveInteger(options.timeoutMs, "timeoutMs");
  }
  return {
    maxDrainMs: positiveInteger(
      options.maxDrainMs ??
        options.timeoutMs ??
        DEFAULT_SCHEDULED_INGEST_BUDGET.maxDrainMs,
      "maxDrainMs",
    ),
    maxCandidates: positiveInteger(
      options.maxCandidates ?? DEFAULT_SCHEDULED_INGEST_BUDGET.maxCandidates,
      "maxCandidates",
    ),
    maxSerializedBytes: positiveInteger(
      options.maxSerializedBytes ??
        DEFAULT_SCHEDULED_INGEST_BUDGET.maxSerializedBytes,
      "maxSerializedBytes",
    ),
  };
}

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

/** One bounded feed-prune slice: advances the persisted rolling cursor by up to
 *  {@link FEED_PRUNE_SWEEP_ACTORS} actors and reports whether the slice reached
 *  the end of the actor list (i.e. a full pass just completed and the cursor
 *  wrapped). Callers decide WHEN to sweep (ingest-dirty vs recovery); this owns
 *  the slice + cursor mechanics so the cron loop, the persistent loop, and the
 *  notify path all prune identically. No-op (done) when no feed caps apply. */
export async function runFeedPruneSlice(
  db: Database,
  config: ContrailConfig
): Promise<{ pruned: number; done: boolean }> {
  const caps = buildFeedTargetCaps(config);
  if (caps.size === 0) return { pruned: 0, done: true };
  const cursor = await getFeedPruneCursor(db);
  const { pruned, nextCursor, done } = await sweepFeedItems(
    db,
    caps,
    cursor,
    FEED_PRUNE_SWEEP_ACTORS
  );
  await saveFeedPruneCursor(db, nextCursor);
  return { pruned, done };
}

/** Gate and run one feed-prune slice against the *persisted* recovery clock —
 *  shared by the recycling cron isolate and the stateless `notifyOfUpdate` path
 *  (the long-lived persistent loop uses its in-memory clocks instead). Slices
 *  when `feedTouched` (a feed-mutating record was just ingested) or when a full
 *  pass is overdue, and records pass completion so the recovery clock measures
 *  from a real drain (one slice per tick until the cursor wraps) rather than
 *  resetting on a single slice.
 *
 *  The slice advances the shared rolling cursor, which is NOT necessarily the
 *  actor the mutation touched: a fan-out follower the cursor has already passed
 *  is pruned by the next pass, up to about one recovery interval later, not
 *  instantly. That is
 *  the deliberate trade for a per-tick cost bounded by `FEED_PRUNE_SWEEP_ACTORS`
 *  rather than by fan-out size (a popular author has unboundedly many followers).
 *  feed_items is a soft cache, so a follower sitting a few rows over cap until
 *  the next slice is harmless. No-op when feeds are unconfigured. */
export async function runGatedFeedPrune(
  db: Database,
  config: ContrailConfig,
  feedTouched: boolean
): Promise<void> {
  if (!config.feeds) return;
  if (buildFeedTargetCaps(config).size === 0) return;
  const nowMs = Date.now();
  const lastFullPassMs =
    (await getMetaNumber(db, FEED_PRUNE_LAST_FULL_PASS_META)) ?? 0;
  const recoveryDue = nowMs - lastFullPassMs >= FEED_PRUNE_RECOVERY_INTERVAL_MS;
  if (!feedTouched && !recoveryDue) return;
  const { pruned, done } = await runFeedPruneSlice(db, config);
  if (done) await setMeta(db, FEED_PRUNE_LAST_FULL_PASS_META, String(nowMs));
  if (pruned > 0) {
    getLogger(config).log(
      `Pruned ${pruned} feed items (sweep, reason=${feedTouched ? "ingest" : "recovery"})`
    );
  }
}

/** Mutable state that persists across ingest cycles within the same process. */
export interface IngestState {
  cachedKnownDids?: Set<string>;
  schemaInitialized: boolean;
  /** Wall-clock of the last feed sweep slice — used only by the long-lived
   *  persistent loop to throttle ingest-driven slices; the recycling cron
   *  isolate persists its clocks in `_contrail_meta` instead. */
  lastFeedSweepMs: number;
  /** Wall-clock at which the persistent loop last *completed a full sweep pass*
   *  over every actor. Drives the recovery interval (a fresh pass becomes due
   *  {@link FEED_PRUNE_RECOVERY_INTERVAL_MS} after the last one completed, then
   *  laps one slice per tick), independent of the ingest-driven throttle above.
   *  The cron isolate persists the equivalent in
   *  `_contrail_meta`. */
  lastFullFeedPassMs: number;
  /** Set by the persistent loop when a flushed batch ingested a feed-mutating
   *  record, so the next sweep window knows there may be prune work. Cleared
   *  when the sweep runs. The cron path makes the same decision per-tick from
   *  its `events` array and doesn't need the flag. */
  feedDirty: boolean;
}

export function createIngestState(): IngestState {
  return {
    schemaInitialized: false,
    lastFeedSweepMs: 0,
    lastFullFeedPassMs: 0,
    feedDirty: false,
  };
}

function getLogger(config: ContrailConfig): Logger {
  return config.logger ?? console;
}

/** Sentinel returned by `nextWithDeadline` when the wait timed out. */
const INGEST_TIMEOUT = Symbol("ingest-timeout");

/** Await the iterator's next value, but give up after `ms`. Without this a
 * quiet Jetstream can hold a scheduled drain past its deadline. */
function nextWithDeadline<T>(
  iterator: AsyncIterator<T>,
  ms: number,
): Promise<IteratorResult<T> | typeof INGEST_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout>;
  const next = iterator.next();
  // The transport currently has no structural cancellation seam. If the timer
  // wins, swallow a later rejection while the iterator is closed best-effort.
  next.catch(() => {});
  const timeout = new Promise<typeof INGEST_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(INGEST_TIMEOUT), ms);
  });
  return Promise.race([next, timeout]).finally(() => clearTimeout(timer));
}

const utf8 = new TextEncoder();
const MAX_DIAGNOSTIC_SAMPLES = 5;
const MAX_DIAGNOSTIC_SAMPLE_LENGTH = 320;

function addDiagnosticSample(
  stats: Pick<
    ScheduledIngestCollectionStats,
    "diagnosticSamples" | "diagnosticSamplesOmitted"
  >,
  message: string,
): void {
  if (stats.diagnosticSamples.length >= MAX_DIAGNOSTIC_SAMPLES) {
    stats.diagnosticSamplesOmitted++;
    return;
  }
  stats.diagnosticSamples.push(message.slice(0, MAX_DIAGNOSTIC_SAMPLE_LENGTH));
}

/** JSON normalization used only for transport-observation fingerprints. The
 * Jetstream payload has already been decoded from JSON, so sorting object keys
 * makes semantically identical payloads stable across decoder/property order. */
function normalizedJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => normalizedJson(item)).join(",")}]`;
  }
  const fields: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined) continue;
    fields.push(`${JSON.stringify(key)}:${normalizedJson(field)}`);
  }
  return `{${fields.join(",")}}`;
}

async function observationHash(value: string): Promise<string> {
  const subtle = (
    globalThis as typeof globalThis & {
      crypto?: {
        subtle?: {
          digest(
            algorithm: string,
            data: Uint8Array,
          ): Promise<ArrayBuffer>;
        };
      };
    }
  ).crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SHA-256 is required for ingestion");
  const digest = await subtle.digest("SHA-256", utf8.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface JetstreamCommitObservation {
  /** One logical Jetstream source slot, before source ID/epoch prefixing. */
  key: string;
  /** Stable operation/CID/normalized-payload identity for that slot. */
  fingerprint: string;
  uri: string;
}

/** Jetstream owns the transport-specific observation identity. Core collection
 * adds the configured source ID and epoch before cycle-local deduplication. */
function jetstreamCommitObservation(
  event: {
    did: string;
    time_us: number;
    commit: {
      rev?: string;
      collection: string;
      rkey: string;
      operation: string;
      cid?: string;
      record?: unknown;
    };
  },
): JetstreamCommitObservation {
  const { commit } = event;
  const uri = `at://${event.did}/${commit.collection}/${commit.rkey}`;
  return {
    key: JSON.stringify([event.time_us, uri, commit.rev ?? null]),
    fingerprint: JSON.stringify([
      commit.operation,
      commit.cid ?? null,
      commit.operation === "delete" ? null : normalizedJson(commit.record),
    ]),
    uri,
  };
}

export async function ingestEvents(
  config: ContrailConfig,
  cursor: number | null,
  budgetInput: ScheduledIngestOptions | ScheduledIngestBudget | number =
    DEFAULT_SCHEDULED_INGEST_BUDGET,
  knownDids?: Set<string>,
  startingCursorObservations: ReadonlySet<string> = new Set(),
): Promise<{
  events: IngestEvent[];
  lastCursor: number | null;
  cursorObservations: Set<string>;
  identityUpdates: Map<string, string>;
  stats: ScheduledIngestCollectionStats;
}> {
  const budget = resolveScheduledIngestBudget(budgetInput);
  const startTimeUs = Date.now() * 1000;
  const deadline = Date.now() + budget.maxDrainMs;
  const collected: IngestEvent[] = [];

  const collections = getCollectionNsids(config);
  const dependentCollections = new Set(getDependentNsids(config));
  const provisionalKnownDids = knownDids ? new Set(knownDids) : undefined;
  const urls = config.jetstreams ?? DEFAULT_JETSTREAMS;
  const sourceId = config.orderedSource?.source ?? "jetstream";
  const sourceEpoch = config.orderedSource?.epoch ?? null;

  const seenObservations = new Map<string, Set<string>>();
  const identityUpdates = new Map<string, string>();
  const stats: ScheduledIngestCollectionStats = {
    observedSourceItems: 0,
    commitObservations: 0,
    identityObservations: 0,
    retainedCandidates: 0,
    exactDuplicatesDropped: 0,
    cursorBoundaryDuplicatesDropped: 0,
    resumeOverlapDropped: 0,
    sourceScopeFiltered: 0,
    sourceInconsistencies: 0,
    serializedCandidateBytes: 0,
    startingCursor: cursor,
    lastAccountedCursor: null,
    safeEndingCursor: cursor,
    stopReason: "idle",
    connections: 0,
    connectionCloses: 0,
    connectionErrors: 0,
    diagnosticSamples: [],
    diagnosticSamplesOmitted: 0,
  };

  // A durable timestamp cursor is resumed one microsecond earlier. This works
  // with inclusive and exclusive timestamp APIs: all observations at the
  // coarse cursor are replayed, while persisted hashes suppress only the exact
  // items already accounted for there. It also protects a captured empty-start
  // cursor from a later item that happens to share its microsecond.
  const requestedCursor =
    cursor === null ? null : Math.max(0, cursor - 1);
  const subscription = new JetstreamSubscription({
    // A single-instance config is handed over as a string so @atcute skips its
    // array-only first-connect cursor rollback (see jetstreamUrlOption).
    url: jetstreamUrlOption(urls),
    wantedCollections: collections,
    ...(requestedCursor !== null ? { cursor: requestedCursor } : {}),
    onConnectionOpen() {
      stats.connections++;
    },
    onConnectionClose() {
      stats.connectionCloses++;
    },
    onConnectionError(event) {
      stats.connectionErrors++;
      addDiagnosticSample(stats, `Jetstream connection error: ${String(event.error)}`);
    },
  });

  // Capture Atcute's constructor cursor before iteration can buffer frames and
  // move it ahead. With no durable cursor this is the subscription's effective
  // lower bound and must be persisted even when the first drain stays empty.
  const effectiveStartCursor = cursor ?? subscription.cursor ?? null;
  stats.safeEndingCursor = effectiveStartCursor;
  let boundaryCursor = effectiveStartCursor;
  let boundaryObservations = new Set(startingCursorObservations);
  // Only hashes newly accounted for this cycle are returned for insertion. The
  // database unions them with existing boundary rows, keeping each DB batch
  // bounded even if many cycles share one coarse cursor.
  let cursorObservations = new Set<string>();
  const singleEndpoint = urls.length === 1;

  const iterator = subscription[Symbol.asyncIterator]();
  type Ev = typeof subscription extends AsyncIterable<infer V> ? V : never;

  const accountSourceItem = async (
    event: Ev,
    identity: string,
  ): Promise<boolean> => {
    // The scheduled path requires one pinned endpoint. Its one-microsecond
    // boundary overlap is known-complete below the durable cursor and must not
    // consume candidate/byte budgets on every restart.
    if (
      singleEndpoint &&
      effectiveStartCursor !== null &&
      event.time_us < effectiveStartCursor
    ) {
      stats.resumeOverlapDropped++;
      return true;
    }

    const hash = await observationHash(
      JSON.stringify([sourceId, sourceEpoch, identity]),
    );
    if (boundaryCursor === null || event.time_us > boundaryCursor) {
      boundaryCursor = event.time_us;
      boundaryObservations = new Set([hash]);
      cursorObservations = new Set([hash]);
    } else if (event.time_us === boundaryCursor) {
      const alreadyAccounted = boundaryObservations.has(hash);
      boundaryObservations.add(hash);
      if (!alreadyAccounted) cursorObservations.add(hash);
    }

    if (
      effectiveStartCursor !== null &&
      event.time_us === effectiveStartCursor &&
      startingCursorObservations.has(hash)
    ) {
      stats.cursorBoundaryDuplicatesDropped++;
      return true;
    }
    return false;
  };

  // Fully account for one yielded item before the loop considers any stop
  // threshold. Exact boundary observations are suppressed before evolving
  // source-scope policy; ordinary cheap filters still precede cycle dedupe.
  const handleEvent = async (event: Ev): Promise<void> => {
    if (event.kind === "commit") {
      const { commit } = event;
      stats.commitObservations++;
      const observation = jetstreamCommitObservation(event);
      const dedupeKey = JSON.stringify([
        sourceId,
        sourceEpoch,
        observation.key,
      ]);
      if (
        await accountSourceItem(
          event,
          JSON.stringify([
            "commit",
            observation.key,
            observation.fingerprint,
          ]),
        )
      ) {
        return;
      }

      if (
        provisionalKnownDids &&
        !dependentCollections.has(commit.collection) &&
        commit.operation !== "delete"
      ) {
        provisionalKnownDids.add(event.did);
      }
      if (
        dependentCollections.has(commit.collection) &&
        provisionalKnownDids &&
        !provisionalKnownDids.has(event.did)
      ) {
        stats.sourceScopeFiltered++;
        return;
      }

      const fingerprints = seenObservations.get(dedupeKey);
      if (fingerprints?.has(observation.fingerprint)) {
        stats.exactDuplicatesDropped++;
        return;
      }
      if (fingerprints) {
        stats.sourceInconsistencies++;
        addDiagnosticSample(
          stats,
          `source slot changed payload: ${observation.uri} time_us=${event.time_us}`,
        );
        fingerprints.add(observation.fingerprint);
      } else {
        seenObservations.set(dedupeKey, new Set([observation.fingerprint]));
      }

      const candidate = createIngestEvent({
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
          id: sourceId,
          ...(sourceEpoch === null ? {} : { epoch: sourceEpoch }),
          time_us: event.time_us,
          revision: commit.rev,
          cursor: String(event.time_us),
        },
      });
      collected.push(candidate);
      stats.retainedCandidates++;
      stats.serializedCandidateBytes +=
        SCHEDULED_INGEST_METADATA_BYTES +
        (candidate.record === null ? 0 : utf8.encode(candidate.record).byteLength);
    } else if (event.kind === "identity") {
      stats.identityObservations++;
      if (await accountSourceItem(event, normalizedJson(event))) return;
      identityUpdates.set(event.did, event.identity.handle);
    } else {
      await accountSourceItem(event, normalizedJson(event));
    }
  };

  for (;;) {
    // Check the deadline before requesting another item. A hot iterator must not
    // get one extra next() after any threshold has been reached.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      stats.stopReason = "drain-time";
      break;
    }

    const step = await nextWithDeadline(iterator, remainingMs);
    if (step === INGEST_TIMEOUT) {
      stats.stopReason = "drain-time";
      break;
    }
    if (step.done) {
      stats.stopReason = "idle";
      break;
    }
    const event = step.value;
    stats.observedSourceItems++;

    await handleEvent(event);
    // handleEvent either retained, filtered, deduplicated, or deliberately
    // handled the item. Only now is its cursor safe to checkpoint. Keep the
    // representable checkpoint monotonic across deliberate overlap replay.
    stats.lastAccountedCursor = Math.max(
      stats.lastAccountedCursor ?? event.time_us,
      event.time_us,
    );

    if (stats.retainedCandidates >= budget.maxCandidates) {
      stats.stopReason = "count";
      break;
    }
    if (stats.serializedCandidateBytes >= budget.maxSerializedBytes) {
      stats.stopReason = "bytes";
      break;
    }
    if (event.time_us >= startTimeUs) {
      stats.stopReason = "head";
      break;
    }
  }

  // Close the subscription's socket, but fire-and-forget: awaiting the
  // iterator's return on a quiet stream could itself block (the hang we fix).
  Promise.resolve(iterator.return?.()).catch(() => {});

  // Never read Atcute's cursor again here: it may have moved when a frame was
  // buffered but not yielded. The constructor cursor captured above and the
  // maximum fully-accounted yielded cursor are the only safe positions.
  const lastCursor =
    effectiveStartCursor === null
      ? stats.lastAccountedCursor
      : Math.max(
          effectiveStartCursor,
          stats.lastAccountedCursor ?? effectiveStartCursor,
        );
  stats.safeEndingCursor = lastCursor;
  if (lastCursor !== boundaryCursor) {
    // This occurs only for an older deliberate overlap. Leave the durable
    // boundary unchanged rather than attaching old hashes to a newer cursor.
    cursorObservations = new Set();
  }

  return {
    events: collected,
    lastCursor,
    cursorObservations,
    identityUpdates,
    stats,
  };
}

function emptyDropCounts(): IngestDropCounts {
  return {
    unknownCollection: 0,
    invalidRecord: 0,
    lexiconValidation: 0,
    cidMismatch: 0,
    cidEncoding: 0,
    missingCid: 0,
    recordFilter: 0,
    unknownActor: 0,
    unknownSubject: 0,
    superseded: 0,
  };
}

function addDropCounts(target: IngestDropCounts, value: IngestDropCounts): void {
  for (const key of Object.keys(target) as Array<keyof IngestDropCounts>) {
    target[key] += value[key];
  }
}

function admissionFilteredCount(dropped: IngestDropCounts): number {
  return Object.entries(dropped).reduce(
    (total, [key, value]) => key === "superseded" ? total : total + value,
    0,
  );
}

function runtimeCpuUsage(): (() => number) | null {
  const runtimeProcess = (
    globalThis as typeof globalThis & {
      process?: {
        cpuUsage?: (previous?: { user: number; system: number }) => {
          user: number;
          system: number;
        };
      };
    }
  ).process;
  if (!runtimeProcess?.cpuUsage) return null;
  const start = runtimeProcess.cpuUsage();
  return () => {
    const elapsed = runtimeProcess.cpuUsage!(start);
    return Math.round((elapsed.user + elapsed.system) / 100) / 10;
  };
}

// Run a full ingest cycle: init schema, load cursor, ingest, apply, save cursor
export async function runIngestCycle(
  db: Database,
  config: ContrailConfig,
  budgetInput: ScheduledIngestOptions | ScheduledIngestBudget | number =
    DEFAULT_SCHEDULED_INGEST_BUDGET,
  state?: IngestState,
): Promise<void> {
  const log = getLogger(config);
  const budget = resolveScheduledIngestBudget(budgetInput);
  const scheduledUrls = config.jetstreams ?? DEFAULT_JETSTREAMS;
  if (scheduledUrls.length !== 1) {
    throw new TypeError(
      "scheduled ingestion requires exactly one pinned Jetstream endpoint; " +
        "use runPersistent() for a failover pool",
    );
  }
  const wallStartedAt = Date.now();
  const finishCpuUsage = runtimeCpuUsage();
  const s = state ?? createIngestState();

  if (!s.schemaInitialized) {
    await initSchema(db, config);
    s.schemaInitialized = true;
  }

  const cursor = await getLastCursor(db);
  const startingCursorObservations =
    cursor === null ? new Set<string>() : await getCursorObservations(db, cursor);

  // Load known DIDs for filtering dependent collections
  const dependentCollections = getDependentNsids(config);
  let knownDids: Set<string> | undefined;

  if (dependentCollections.length > 0) {
    if (s.cachedKnownDids) {
      knownDids = s.cachedKnownDids;
    } else {
      const result = await db
        .prepare("SELECT did FROM identities")
        .all<{ did: string }>();
      knownDids = new Set((result.results ?? []).map((r) => r.did));
      s.cachedKnownDids = knownDids;
    }
  }

  const {
    events,
    lastCursor,
    cursorObservations,
    identityUpdates,
    stats,
  } = await ingestEvents(
    config,
    cursor,
    budget,
    knownDids,
    startingCursorObservations,
  );

  const accepted: IngestEvent[] = [];
  const newlyKnownDids: string[] = [];
  const dropped = emptyDropCounts();
  let databaseSubBatchesCommitted = 0;
  const warningSamples: IngestWarningSamples = {
    maxSamples: MAX_DIAGNOSTIC_SAMPLES,
    samples: stats.diagnosticSamples,
    omitted: stats.diagnosticSamplesOmitted,
  };
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const isFinalBatch = i + BATCH_SIZE >= events.length;
    const result = await ingestRecords(db, batch, config, {
      knownDids,
      warningSamples,
      // Earlier batches may commit without moving the cursor. A crash replays
      // them safely; the final batch atomically commits the exact source cursor.
      trailingStatements:
        isFinalBatch && lastCursor !== null
          ? [
              saveCursorStatement(db, lastCursor),
              ...(config.orderedSource
                ? [
                    saveOrderedSourcePositionStatement(
                      db,
                      config.orderedSource,
                      lastCursor,
                    ),
                  ]
                : []),
              ...saveCursorObservationStatements(
                db,
                lastCursor,
                cursorObservations,
              ),
            ]
          : undefined,
    });
    databaseSubBatchesCommitted++;
    accepted.push(...result.accepted);
    addDropCounts(dropped, result.dropped);
    if (knownDids) {
      for (const did of result.discoveredDids) {
        knownDids.add(did);
        newlyKnownDids.push(did);
      }
    }
  }

  // Apply handle changes from #identity events. UPDATE-only, so unknown DIDs
  // are no-ops. Failures are sampled into the bounded cycle summary.
  let identityUpdateFailures = 0;
  for (const [did, handle] of identityUpdates) {
    try {
      await applyIdentityEvent(db, did, handle);
    } catch (error) {
      identityUpdateFailures++;
      if (warningSamples.samples.length < warningSamples.maxSamples) {
        warningSamples.samples.push(
          `identity update failed for ${did}: ${String(error)}`.slice(
            0,
            MAX_DIAGNOSTIC_SAMPLE_LENGTH,
          ),
        );
      } else {
        warningSamples.omitted++;
      }
    }
  }

  // A commit batch saves its source cursor in the projection transaction above.
  // Identity-only, filtered-only, or otherwise candidate-free accounted ranges
  // checkpoint only after best-effort identity handling. No observed item means
  // there is no new source work to save, even if the subscription buffered ahead.
  if (
    lastCursor !== null &&
    events.length === 0 &&
    // Save an accounted range, or capture Atcute's constructor cursor for an
    // empty first drain so the next cron cannot silently start later.
    (stats.lastAccountedCursor !== null || cursor === null)
  ) {
    await saveCursor(
      db,
      lastCursor,
      config.orderedSource,
      cursorObservations,
    );
    databaseSubBatchesCommitted++;
  }

  // Refresh stale/missing identities for DIDs in this batch (best-effort; runs
  // after the cursor save so its network latency can't strand forward progress).
  const uniqueDids = [...new Set(accepted.map((e) => e.did))];
  let identityRefreshFailures = 0;
  if (uniqueDids.length > 0) {
    try {
      await refreshStaleIdentities(db, uniqueDids, config);
    } catch (error) {
      identityRefreshFailures++;
      if (warningSamples.samples.length < warningSamples.maxSamples) {
        warningSamples.samples.push(
          `identity refresh failed: ${String(error)}`.slice(
            0,
            MAX_DIAGNOSTIC_SAMPLE_LENGTH,
          ),
        );
      } else {
        warningSamples.omitted++;
      }
    }
  }

  // Newly-discovered DIDs: ask Constellation for back-edges. Suppress helper
  // per-subject logs and report bounded aggregate results in the cycle summary.
  let constellationFailures = 0;
  let constellationInserted = 0;
  if (config.feeds && newlyKnownDids.length > 0) {
    const quietConfig = {
      ...config,
      logger: { log() {}, warn() {}, error() {} },
    };
    for (const subj of newlyKnownDids) {
      try {
        constellationInserted += await backfillFollowersFromConstellation(
          db,
          quietConfig,
          subj,
        );
      } catch (error) {
        constellationFailures++;
        if (warningSamples.samples.length < warningSamples.maxSamples) {
          warningSamples.samples.push(
            `constellation failed for ${subj}: ${String(error)}`.slice(
              0,
              MAX_DIAGNOSTIC_SAMPLE_LENGTH,
            ),
          );
        } else {
          warningSamples.omitted++;
        }
      }
    }
  }

  // Prune feed_items to per-collection caps with a bounded, cursored sweep.
  // Every statement is index-backed and O(cap) (see sweepFeedItems), so it can
  // never exhaust D1's per-query CPU budget and reset the shared DO — unlike
  // the old global window+anti-join. The cron isolate recycles each tick, so the
  // sweep cursor and the recovery clock both live in the DB.
  //
  // A feed only goes over cap right after a row is inserted, and rows are only
  // inserted for feed-mutating collections (event fan-out, follow backfill). So
  // we skip the sweep entirely on ticks that ingested nothing feed-relevant —
  // the overwhelming majority — and otherwise advance one bounded slice.
  //
  // The recovery clock tracks when a *full pass* over every actor last
  // completed, not the last slice: while a pass is overdue we keep slicing every
  // tick (bounded cost) until the cursor wraps, then reset the clock. That bounds
  // the worst-case time an over-cap feed waits to be revisited — a feed touched
  // just after the cursor passed it, a lowered cap, or a bulk import all drain
  // within one recovery interval plus the pass's lap time, instead of stalling
  // for many intervals (one slice per interval) as a per-slice clock would.
  if (config.feeds) {
    const feedMutatingNsids = getFeedMutatingNsids(config);
    const feedTouched = accepted.some((e) => feedMutatingNsids.has(e.collection));
    await runGatedFeedPrune(db, config, feedTouched);
  }

  // Opt-in planner-stat maintenance (gated + persisted cadence; no-op unless
  // config.maintenance.optimize is set).
  await maybeOptimize(db, config, log);

  const summary = {
    observed_source_items: stats.observedSourceItems,
    commit_observations: stats.commitObservations,
    identity_observations: stats.identityObservations,
    retained_candidates: stats.retainedCandidates,
    exact_duplicates_dropped: stats.exactDuplicatesDropped,
    cursor_boundary_duplicates_dropped:
      stats.cursorBoundaryDuplicatesDropped,
    resume_overlap_dropped: stats.resumeOverlapDropped,
    source_scope_filtered: stats.sourceScopeFiltered,
    admission_policy_filtered: admissionFilteredCount(dropped),
    candidates_superseded: dropped.superseded,
    source_inconsistencies: stats.sourceInconsistencies,
    serialized_candidate_bytes: stats.serializedCandidateBytes,
    max_candidates: budget.maxCandidates,
    max_serialized_bytes: budget.maxSerializedBytes,
    max_drain_ms: budget.maxDrainMs,
    starting_cursor: cursor,
    last_accounted_cursor: stats.lastAccountedCursor,
    safe_ending_cursor: stats.safeEndingCursor,
    stop_reason: stats.stopReason,
    database_sub_batches_committed: databaseSubBatchesCommitted,
    projected_mutations_accepted: accepted.length,
    identity_updates_attempted: identityUpdates.size,
    identity_update_failures: identityUpdateFailures,
    identity_refresh_failures: identityRefreshFailures,
    constellation_inserted: constellationInserted,
    constellation_failures: constellationFailures,
    connections: stats.connections,
    connection_closes: stats.connectionCloses,
    connection_errors: stats.connectionErrors,
    wall_ms: Date.now() - wallStartedAt,
    cpu_ms: finishCpuUsage?.() ?? null,
    diagnostic_samples: warningSamples.samples,
    diagnostic_samples_omitted: warningSamples.omitted,
  };
  log.log(`[ingest] cycle summary ${JSON.stringify(summary)}`);
}
