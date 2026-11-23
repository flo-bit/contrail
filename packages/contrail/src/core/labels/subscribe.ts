import { decodeFirst } from "@atcute/cbor";
import type { ContrailConfig, Database, Logger } from "../types";
import type { LabelerSource } from "./types";
import { applyLabels, type IncomingLabel } from "./apply";
import { getLabelerState } from "./resolve";
import { getMeta, setMeta } from "../db/meta";
import {
  getModerationPolicyGeneration,
  lockModerationPolicyStatement,
  moderationPolicyGenerationSql,
} from "../moderation-policy";

/** Stop an obsolete subscription rather than advancing the shared cursor or
 * reconnecting forever with a superseded deployment's admission rules. */
class ObsoleteLabelPolicyError extends Error {}

const DEFAULT_CYCLE_TIMEOUT_MS = 25_000;
const DEFAULT_BATCH_SIZE = 100;
/** Unflushed batches retained before the socket is closed for a retry. */
const MAX_BUFFERED_BATCHES = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
/** When a `backfill: false` labeler was first followed from now. */
const LIVE_SINCE_KEY_PREFIX = "labeler_live_since:";
const LIVE_SINCE_SKEW_MS = 5 * 60_000;

function getLogger(config: ContrailConfig): Logger {
  return config.logger ?? console;
}

/** One catch-up cycle for every configured labeler. Pump sources concurrently
 * under a shared deadline: subscribeLabels sockets normally stay open even
 * after catching up, so sequential pumps would starve all later sources.
 * Each source saves its own cursor before disconnecting. */
export async function runLabelIngestCycle(
  db: Database,
  config: ContrailConfig,
  timeoutMs = DEFAULT_CYCLE_TIMEOUT_MS,
): Promise<void> {
  if (!config.labels) return;
  const log = getLogger(config);
  const deadline = Date.now() + timeoutMs;

  await Promise.all(
    config.labels.sources.filter((source) => !source.records).map(async (source) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      try {
        await pumpOneLabeler(
          db,
          source,
          log,
          remaining,
          /* persistent */ false,
          {},
          config,
        );
      } catch (err) {
        if (err instanceof ObsoleteLabelPolicyError) return;
        log.warn(`[labels] cycle for ${source.did} failed: ${err}`);
      }
    }),
  );
}

export interface PersistentLabelsOptions {
  signal?: AbortSignal;
  batchSize?: number;
  flushIntervalMs?: number;
  logger?: Logger;
}

/** Long-lived equivalent — keeps one socket per labeler open forever, with
 *  exponential backoff reconnect. Mirrors `runPersistent` for jetstream. */
export async function runPersistentLabels(
  db: Database,
  config: ContrailConfig,
  options: PersistentLabelsOptions = {},
): Promise<void> {
  if (!config.labels) return;
  const log = options.logger ?? config.logger ?? console;
  const signal = options.signal;

  const tasks = config.labels.sources.filter((s) => !s.records).map((source) =>
    runOneLabelerForever(db, source, log, signal, options, config),
  );
  await Promise.all(tasks);
}

async function runOneLabelerForever(
  db: Database,
  source: LabelerSource,
  log: Logger,
  signal: AbortSignal | undefined,
  options: PersistentLabelsOptions,
  config: ContrailConfig,
): Promise<void> {
  let attempts = 0;
  while (!signal?.aborted) {
    try {
      await pumpOneLabeler(
        db,
        source,
        log,
        /* timeoutMs */ Infinity,
        true,
        {
          signal,
          batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
          flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
        },
        config,
      );
      attempts = 0;
    } catch (err) {
      if (signal?.aborted || err instanceof ObsoleteLabelPolicyError) break;
      log.error(`[labels] ${source.did} stream error: ${err}`);
      const delay = Math.min(1_000 * 2 ** attempts, 30_000);
      attempts++;
      log.log(`[labels] ${source.did} reconnecting in ${delay}ms (attempt ${attempts})`);
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

interface PumpOptions {
  signal?: AbortSignal;
  batchSize?: number;
  flushIntervalMs?: number;
}

/** Open a `subscribeLabels` WebSocket, drain frames into a buffer, flush
 *  the buffer to `labels` in batches, and persist the seq cursor. Returns
 *  when:
 *   - the labeler closes the socket cleanly (caught up + no more events)
 *   - `timeoutMs` is reached (cron mode)
 *   - `signal` is aborted (persistent mode)
 *   - an error tears the socket down (caller may retry) */
async function pumpOneLabeler(
  db: Database,
  source: LabelerSource,
  log: Logger,
  timeoutMs: number,
  persistent: boolean,
  pumpOpts: PumpOptions,
  config: ContrailConfig,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Capture before any endpoint resolution/network I/O. The nonce also rejects
  // a buffered batch from before a policy change that was subsequently reverted.
  const policyGeneration = await getModerationPolicyGeneration(db, config);
  if (!policyGeneration) throw new ObsoleteLabelPolicyError("Label policy is no longer current");
  const writeGuard = {
    sql: moderationPolicyGenerationSql(),
    bindings: [policyGeneration],
  };
  if (Date.now() >= deadline) return;
  const state = await getLabelerState(db, source.did, source.endpoint, {
    ...config.networkOverrides,
    ...(Number.isFinite(deadline)
      ? { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }
      : {}),
  });
  if (Date.now() >= deadline) return;
  if (!state) {
    log.warn(`[labels] could not resolve labeler endpoint for ${source.did}; skipping`);
    return;
  }

  // First-time policy: cursor 0 = "from the beginning" if backfill is on
  // (default), null = "from now" otherwise. After the first cycle we always
  // resume from the saved cursor — `backfill` only flips the start point.
  const isFirstRun = state.cursor === 0;
  const backfill = source.backfill !== false;
  let startCursor: number | null = state.cursor;
  // `backfill: false` without a saved cursor: a "from now" connection that
  // saw no frame has no seq to resume from, so labels issued while scheduled
  // ingestion was disconnected would be skipped indefinitely for a quiet
  // labeler. Only the first such connection starts from now; later ones
  // replay from 0, admitting labels created after that start (minus clock
  // skew). Keep that cutoff on every reconnect: replay can span multiple
  // bounded cycles, and a nonzero cursor does not prove it has caught up.
  let minCts: number | null = null;
  if (!backfill) {
    const sinceKey = `${LIVE_SINCE_KEY_PREFIX}${source.did}`;
    const since = Number(await getMeta(db, sinceKey));
    if (since > 0) minCts = since - LIVE_SINCE_SKEW_MS;
    else if (isFirstRun) {
      await setMeta(db, sinceKey, String(Date.now()));
      startCursor = null;
    }
  }

  const url = buildWsUrl(state.endpoint!, startCursor);
  log.log(`[labels] connecting to ${source.did} (cursor=${startCursor ?? "now"})`);

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  const buffer: IncomingLabel[] = [];
  let highestSeq = state.cursor;
  let obsoletePolicy = false;
  let flushPending: Promise<void> = Promise.resolve();
  let resolveDone!: () => void;
  let rejectDone!: (err: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const flush = (): Promise<void> => {
    const work = flushPending.catch(() => {}).then(async () => {
      if (obsoletePolicy) return;
      // Freeze the seq with this exact batch, never checkpoint newer frames
      // received while SQL is in flight. Filter-only frames still advance.
      const seq = highestSeq;
      if (!buffer.length && seq <= state.cursor) return;
      const batch = buffer.splice(0);
      try {
        const kept = await applyLabels(db, batch, {
          source,
          config,
          // Consistent lock order with policy replacement and backfill commits:
          // policy -> moderation -> label rows. Every write, including a
          // filter-only frame's checkpoint, uses the same transaction guard.
          leadingStatements: [lockModerationPolicyStatement(db)],
          writeGuard,
          trailingStatements: [
            db.prepare(`INSERT INTO labeler_cursors (did, cursor)
              SELECT CAST(? AS TEXT), CAST(? AS BIGINT) WHERE ${writeGuard.sql}
              ON CONFLICT(did) DO UPDATE SET cursor = excluded.cursor
              WHERE excluded.cursor > labeler_cursors.cursor`)
              .bind(source.did, seq, ...writeGuard.bindings),
          ],
        });
        if (await getModerationPolicyGeneration(db, config) !== policyGeneration)
          throw new ObsoleteLabelPolicyError("Label policy changed during subscription");
        state.cursor = seq;
        log.log(`[labels] ${source.did} flushed ${kept}/${batch.length} labels, cursor=${seq}`);
      } catch (err) {
        if (err instanceof ObsoleteLabelPolicyError) {
          obsoletePolicy = true;
          buffer.length = 0;
          cleanup();
          rejectDone(err);
        } else buffer.unshift(...batch);
        throw err;
      }
    });
    flushPending = work;
    return work;
  };

  const batchSize = pumpOpts.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushInterval = pumpOpts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushFailed = (err: unknown) => {
    if (!(err instanceof ObsoleteLabelPolicyError))
      log.error(`[labels] ${source.did} flush failed (${buffer.length} buffered): ${err}`);
  };
  const flushTimer = setInterval(() => {
    flush().catch(flushFailed);
  }, flushInterval);

  const cleanup = () => {
    clearInterval(flushTimer);
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  };

  // External abort (persistent mode) — close socket gracefully.
  const abortHandler = () => {
    cleanup();
    flush().then(resolveDone, rejectDone);
  };
  pumpOpts.signal?.addEventListener("abort", abortHandler, { once: true });

  // Cron-mode time budget — close socket gracefully when reached.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (Number.isFinite(timeoutMs)) {
    deadlineTimer = setTimeout(() => {
      log.log(`[labels] ${source.did} cycle deadline reached, closing`);
      cleanup();
      flush().then(resolveDone, rejectDone);
    }, Math.max(0, deadline - Date.now()));
  }

  ws.addEventListener("error", (ev) => {
    cleanup();
    if (deadlineTimer) clearTimeout(deadlineTimer);
    pumpOpts.signal?.removeEventListener("abort", abortHandler);
    rejectDone(new Error(`WebSocket error: ${(ev as ErrorEvent)?.message ?? "unknown"}`));
  });

  ws.addEventListener("close", () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    pumpOpts.signal?.removeEventListener("abort", abortHandler);
    clearInterval(flushTimer);
    flush().then(resolveDone, rejectDone);
  });

  ws.addEventListener("message", async (ev) => {
    let bytes: Uint8Array;
    if (ev.data instanceof ArrayBuffer) {
      bytes = new Uint8Array(ev.data);
    } else if (ev.data instanceof Uint8Array) {
      bytes = ev.data;
    } else {
      // Binary-only protocol — text frames shouldn't arrive.
      return;
    }
    const frame = decodeFrame(bytes);
    if (!frame) return;

    if (frame.t === "#labels") {
      const seq = Number(frame.payload?.seq ?? 0);
      const rawLabels = Array.isArray(frame.payload?.labels) ? frame.payload.labels : [];
      for (const raw of rawLabels) {
        const lab = normalizeLabel(raw, source.did);
        if (lab && !(minCts !== null && Date.parse(lab.cts) < minCts)) buffer.push(lab);
      }
      if (Number.isFinite(seq) && seq > highestSeq) highestSeq = seq;
      if (buffer.length >= batchSize * MAX_BUFFERED_BATCHES) {
        // Flushes keep failing: stop reading. The cursor was not advanced past
        // unflushed labels, so the next connection replays them.
        log.error(`[labels] ${source.did} buffer limit reached; closing to retry from cursor`);
        cleanup();
      } else if (buffer.length >= batchSize) {
        flush().catch(flushFailed);
      }
    } else if (frame.t === "#info") {
      const name = String(frame.payload?.name ?? "");
      log.log(`[labels] ${source.did} info: ${name}`);
      if (name === "OutdatedCursor") {
        // Labeler rewound its log — discard our cursor and let the next
        // run start from the beginning. We don't reconnect here; the
        // caller (or the persistent loop) will pick up the reset on retry.
        try {
          await flush();
          await db.batch([
            lockModerationPolicyStatement(db),
            db.prepare(`INSERT INTO labeler_cursors (did, cursor)
              SELECT CAST(? AS TEXT), 0 WHERE ${writeGuard.sql}
              ON CONFLICT(did) DO UPDATE SET cursor = 0`)
              .bind(source.did, ...writeGuard.bindings),
          ]);
          highestSeq = state.cursor = 0;
          cleanup();
        } catch (err) {
          cleanup();
          rejectDone(err);
        }
      }
    } else if (frame.op === -1) {
      log.warn(`[labels] ${source.did} error frame: ${JSON.stringify(frame.payload)}`);
      cleanup();
    }
  });

  // Workers WebSocket doesn't always emit `open`; just await `done` directly.
  try {
    await done;
  } finally {
    cleanup();
    if (deadlineTimer) clearTimeout(deadlineTimer);
    pumpOpts.signal?.removeEventListener("abort", abortHandler);
  }
}

function buildWsUrl(httpEndpoint: string, cursor: number | null): string {
  const u = new URL("/xrpc/com.atproto.label.subscribeLabels", httpEndpoint);
  // wss:// for HTTPS endpoints — the protocol on the labeler service is
  // expected to be HTTPS already (validated at resolution time).
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (cursor !== null) u.searchParams.set("cursor", String(cursor));
  return u.toString();
}

interface DecodedFrame {
  op: number;
  t: string | undefined;
  payload: Record<string, unknown>;
}

/** Decode an atproto subscription frame: two consecutive CBOR objects.
 *  Header `{ op, t? }`, payload — shape depends on `t`. Returns null on
 *  decode failure or non-object frames. */
function decodeFrame(bytes: Uint8Array): DecodedFrame | null {
  try {
    const [header, rest] = decodeFirst(bytes);
    if (!header || typeof header !== "object") return null;
    const op = typeof (header as { op?: number }).op === "number" ? (header as { op: number }).op : 1;
    const t = typeof (header as { t?: string }).t === "string" ? (header as { t: string }).t : undefined;
    const [payload] = decodeFirst(rest);
    if (!payload || typeof payload !== "object") return null;
    return { op, t, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Coerce a wire `Label` object into our `IncomingLabel` shape. Returns
 *  null when required fields are missing — we'd rather skip a row than
 *  insert one with placeholder values. */
function normalizeLabel(raw: unknown, expectedSrc: string): IncomingLabel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const src = typeof r.src === "string" ? r.src : null;
  const uri = typeof r.uri === "string" ? r.uri : null;
  const val = typeof r.val === "string" ? r.val : null;
  const cts = typeof r.cts === "string" ? r.cts : null;
  if (!src || !uri || !val || !cts) return null;
  // A labeler shouldn't emit labels under a different `src` than its own
  // DID — drop them rather than poison our table with cross-issuer rows.
  if (src !== expectedSrc) return null;
  return {
    src,
    uri,
    val,
    cts,
    cid: typeof r.cid === "string" ? r.cid : undefined,
    neg: r.neg === true,
    exp: typeof r.exp === "string" ? r.exp : undefined,
    sig: r.sig instanceof Uint8Array ? r.sig : undefined,
  };
}
