import { decodeFirst } from "@atcute/cbor";
import type { ContrailConfig, Database, Logger } from "../types";
import type { LabelerSource } from "./types";
import { applyLabels, type IncomingLabel } from "./apply";
import {
  getLabelerState,
  resetLabelerCursor,
  saveLabelerCursor,
} from "./resolve";

const DEFAULT_CYCLE_TIMEOUT_MS = 25_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

function getLogger(config: ContrailConfig): Logger {
  return config.logger ?? console;
}

/** One catch-up cycle for every configured labeler. Designed to fit inside a
 *  Cloudflare Workers cron tick — we drain frames until the labeler has no
 *  more buffered events for us, or `timeoutMs` is reached, then save cursor
 *  and disconnect. Mirrors the shape of `runIngestCycle` for jetstream. */
export async function runLabelIngestCycle(
  db: Database,
  config: ContrailConfig,
  timeoutMs = DEFAULT_CYCLE_TIMEOUT_MS,
): Promise<void> {
  if (!config.labels) return;
  const log = getLogger(config);
  const deadline = Date.now() + timeoutMs;

  for (const source of config.labels.sources) {
    if (Date.now() >= deadline) {
      log.log(`[labels] cycle deadline hit before processing ${source.did}`);
      break;
    }
    const remaining = Math.max(2_000, deadline - Date.now());
    try {
      await pumpOneLabeler(db, source, log, remaining, /* persistent */ false);
    } catch (err) {
      log.warn(`[labels] cycle for ${source.did} failed: ${err}`);
    }
  }
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

  const tasks = config.labels.sources.map((source) =>
    runOneLabelerForever(db, source, log, signal, options),
  );
  await Promise.all(tasks);
}

async function runOneLabelerForever(
  db: Database,
  source: LabelerSource,
  log: Logger,
  signal: AbortSignal | undefined,
  options: PersistentLabelsOptions,
): Promise<void> {
  let attempts = 0;
  while (!signal?.aborted) {
    try {
      await pumpOneLabeler(db, source, log, /* timeoutMs */ Infinity, true, {
        signal,
        batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
        flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      });
      attempts = 0;
    } catch (err) {
      if (signal?.aborted) break;
      log.error(`[labels] ${source.did} stream error: ${err}`);
      const delay = Math.min(1_000 * 2 ** attempts, 30_000);
      attempts++;
      log.log(`[labels] ${source.did} reconnecting in ${delay}ms (attempt ${attempts})`);
      await new Promise((r) => setTimeout(r, delay));
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
  pumpOpts: PumpOptions = {},
): Promise<void> {
  const state = await getLabelerState(db, source.did, source.endpoint);
  if (!state) {
    log.warn(`[labels] could not resolve labeler endpoint for ${source.did}; skipping`);
    return;
  }

  // First-time policy: cursor 0 = "from the beginning" if backfill is on
  // (default), null = "from now" otherwise. After the first cycle we always
  // resume from the saved cursor — `backfill` only flips the start point.
  const isFirstRun = state.cursor === 0 && state.resolved_at === null;
  const backfill = source.backfill !== false;
  const startCursor = isFirstRun && !backfill ? null : state.cursor;

  const url = buildWsUrl(state.endpoint!, startCursor);
  log.log(`[labels] connecting to ${source.did} (cursor=${startCursor ?? "now"})`);

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  const buffer: IncomingLabel[] = [];
  let highestSeq = state.cursor;
  let flushing = false;
  let resolveDone!: () => void;
  let rejectDone!: (err: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const flush = async () => {
    if (buffer.length === 0 || flushing) return;
    flushing = true;
    const batch = buffer.splice(0);
    try {
      const kept = await applyLabels(db, batch);
      if (highestSeq > state.cursor) {
        await saveLabelerCursor(db, source.did, highestSeq);
        state.cursor = highestSeq;
      }
      log.log(
        `[labels] ${source.did} flushed ${kept}/${batch.length} labels, cursor=${highestSeq}`,
      );
    } catch (err) {
      log.error(`[labels] ${source.did} flush failed: ${err}`);
    } finally {
      flushing = false;
    }
  };

  const batchSize = pumpOpts.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushInterval = pumpOpts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushTimer = setInterval(() => {
    flush().catch(() => {});
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
    flush().finally(() => resolveDone());
  };
  pumpOpts.signal?.addEventListener("abort", abortHandler, { once: true });

  // Cron-mode time budget — close socket gracefully when reached.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (Number.isFinite(timeoutMs)) {
    deadlineTimer = setTimeout(() => {
      log.log(`[labels] ${source.did} cycle deadline reached, closing`);
      cleanup();
      flush().finally(() => resolveDone());
    }, timeoutMs);
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
    flush().finally(() => {
      clearInterval(flushTimer);
      resolveDone();
    });
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
        if (lab) buffer.push(lab);
      }
      if (Number.isFinite(seq) && seq > highestSeq) highestSeq = seq;
      if (buffer.length >= batchSize) {
        flush().catch(() => {});
      }
    } else if (frame.t === "#info") {
      const name = String(frame.payload?.name ?? "");
      log.log(`[labels] ${source.did} info: ${name}`);
      if (name === "OutdatedCursor") {
        // Labeler rewound its log — discard our cursor and let the next
        // run start from the beginning. We don't reconnect here; the
        // caller (or the persistent loop) will pick up the reset on retry.
        await resetLabelerCursor(db, source.did);
        cleanup();
      }
    } else if (frame.op === -1) {
      log.warn(`[labels] ${source.did} error frame: ${JSON.stringify(frame.payload)}`);
      cleanup();
    }
  });

  // Workers WebSocket doesn't always emit `open`; just await `done` directly.
  await done;
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
