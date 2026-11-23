import { isDid, isNsid, isRecordKey } from "@atcute/lexicons/syntax";
import { getDialect, isPostgresDialect } from "../core/dialect";
import { setMeta } from "../core/db/meta";
import {
  getLastCursor,
  loadKnownActorDids,
  rebuildDerivedProjections,
  saveCursorStatement,
  saveServingSourcePositionStatement,
  type DerivedProjectionResumeCursor,
} from "../core/db/records";
import { createIngestEvent, ingestRecords, recordTimeUs } from "../core/ingest";
import {
  DEFAULT_FOLLOW_SHORT,
  getDependentNsids,
  getDiscoverableNsids,
  nsidForShortName,
  recordsTableName,
  resolveConfig,
  type ContrailConfig,
  type Database,
  type ResolvedContrailConfig,
  type SourcePosition,
  type Statement,
} from "../core/types";

/** Hosted Alluvium service: every current record outside the Bluesky app,
 * exported per collection. */
export const DEFAULT_ALLUVIUM_ENDPOINT = "https://backfill.atmo.tools";

/** How far before the snapshot's time live ingestion starts. Alluvium and
 * the live Jetstream service witness events on separate clocks; the overlap
 * is replayed idempotently. */
export const DEFAULT_ALLUVIUM_REWIND_US = 5 * 60 * 1_000_000;

/** An export is refused when the service's snapshot is older than this.
 * Alluvium rebuilds its snapshot about hourly, and live ingestion replays
 * everything since. That replay must stay well inside the 36 hours a
 * Jetstream service keeps, so an old snapshot means a stalled service. */
export const DEFAULT_ALLUVIUM_MAX_AGE_US = 6 * 60 * 60 * 1_000_000;

/** An unfinished bootstrap is refused once its snapshot is older than this.
 * Its live cursor was fixed when the export was pinned, and a Jetstream
 * service asked to replay from before its retention (36 hours on the public
 * ones) cannot deliver the updates and deletes since. */
export const DEFAULT_ALLUVIUM_REPLAY_WINDOW_US = 24 * 60 * 60 * 1_000_000;

/** `_contrail_meta` key storing resumable Alluvium bootstrap state. */
export const ALLUVIUM_BOOTSTRAP_META_KEY = "alluvium_bootstrap";

/** Secondary indexes dropped for the duration of a bootstrap load, as JSON
 * `[{ name, sql }]`. Present only while they are missing. */
export const BOOTSTRAP_DEFERRED_INDEXES_META_KEY = "bootstrap_deferred_indexes";

const DEFAULT_BATCH_SIZE = 500;
/** Default batch size used by Wrangler/D1 bootstraps (`bootstrapAlluvium`),
 * keeping each `db.batch()` to a handful of `json_each(?)` bulk statements
 * comfortably within D1's payload and CPU ceilings. */
export const DEFAULT_D1_BATCH_SIZE = 250;
/** Default chunk size used by Wrangler/D1 bootstraps (`bootstrapAlluvium`) for
 * paginated FTS and relation-count rebuilds. */
export const DEFAULT_REBUILD_CHUNK_SIZE = 500;
const PROGRESS_LOG_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_CHARACTERS = 2 * 1024 * 1024;
const MAX_COLLECTIONS = 100;
/** Jetstream v2 reads cursors at or above this as unix-microsecond times. */
const TIMESTAMP_CURSOR_MIN = 1_000_000_000_000_000;

/** Thrown when a paused bootstrap's live replay cursor is too old for the
 * live stream to catch up without a gap. */
export class SourceHistoryExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceHistoryExpiredError";
  }
}

export interface AlluviumSourceIdentity {
  /** Ordered source the projection is served from after bootstrap; matches
   * `config.orderedSource.source`. */
  id: string;
  /** Its continuity epoch; matches `config.orderedSource.epoch`. */
  epoch: string;
}

export interface AlluviumTransportOptions {
  /** Attempts per export, each resuming where the last one stopped. */
  maxAttempts?: number;
  /** Time allowed to receive response headers. */
  requestTimeoutMs?: number;
  maxLineCharacters?: number;
  /** Records per projected batch. */
  batchSize?: number;
}

export interface AlluviumBootstrapState {
  v: 1;
  phase: "loading" | "rebuilding" | "complete";
  endpoint: string;
  source: AlluviumSourceIdentity;
  collections: string[];
  /** Service sequence number when the export was pinned; informational. */
  cursor: number;
  /** When the pinned snapshot's last event was witnessed. Every export read
   * for this bootstrap must reach at least this far. */
  timeUs: number;
  /** Timestamp cursor live ingestion resumes from. */
  liveCursorUs: number;
  /** Last projected record URI for resume (`?after=<uri>`), or null. */
  after: string | null;
  /** Resume cursor within the derived-projection rebuild phase, when chunked. */
  rebuild?: DerivedProjectionResumeCursor | null;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface AlluviumProgress {
  phase: "loading" | "rebuilding";
  /** Records loaded so far in `loading`, or rows processed in the current rebuild stage. */
  records: number;
  elapsedMs: number;
  stage?: "fts" | "counts";
  collection?: string;
  relation?: string;
}

export interface LoadAlluviumExportOptions {
  /** Alluvium HTTP origin. Default: {@link DEFAULT_ALLUVIUM_ENDPOINT}. */
  endpoint?: string | URL;
  /** Ordered source handed off to live ingestion. Default: `config.orderedSource`
   * or `{ id: "jetstream", epoch: "alluvium-export" }`. */
  source?: AlluviumSourceIdentity;
  /** Collections to load. Default: `getDiscoverableNsids(config)`. */
  collections?: string[];
  /** Bearer token, when the service requires one. */
  token?: string;
  /** Default: {@link DEFAULT_ALLUVIUM_REWIND_US}. */
  rewindUs?: number;
  /** Default: {@link DEFAULT_ALLUVIUM_MAX_AGE_US}. */
  maxAgeUs?: number;
  /** Default: {@link DEFAULT_ALLUVIUM_REPLAY_WINDOW_US}. */
  replayWindowUs?: number;
  transport?: AlluviumTransportOptions;
  /** Drop secondary indexes on record tables while loading and rebuild them
   * once before completion (SQLite only; leave off for D1). */
  deferIndexes?: boolean;
  /** Chunk size for paginated derived-projection rebuilds (set automatically
   * to {@link DEFAULT_REBUILD_CHUNK_SIZE} by `bootstrapAlluvium` for D1). Omit
   * or pass `0` for single-statement bulk rebuilds (fastest on SQLite/Postgres). */
  rebuildChunkSize?: number;
  /** Optional progress callback invoked on every committed batch / rebuild chunk. */
  onProgress?: (progress: AlluviumProgress) => void;
  fetch?: typeof fetch;
  /** Permit HTTP to a non-loopback host. Loopback endpoints never need it.
   * Default: false. */
  allowInsecureHttp?: boolean;
  /** Clock override for tests. */
  now?: () => number;
  signal?: AbortSignal;
}

export interface LoadAlluviumExportResult {
  /** Position live ingestion resumes from: a timestamp cursor. */
  handoff: SourcePosition;
  /** The cursor live ingestion reads next. After a completed bootstrap has
   * handed off, this is wherever live ingestion has got to. */
  liveCursor: number;
  resumed: boolean;
  /** An earlier run had already completed this bootstrap; nothing was loaded. */
  alreadyComplete: boolean;
  /** Number of records projected during this invocation. */
  recordsLoaded: number;
}

interface AlluviumHead {
  cursor: number;
  timeUs: number;
  excludes: string[];
}

interface ExportRecord {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  cid: string;
  value: Record<string, unknown>;
  timeUs: number;
}

/** Thrown when an export stream ends before its closing line. The records
 * received so far are valid; the export resumes after the last one. */
class AlluviumExportInterruptedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AlluviumExportInterruptedError";
  }
}

/** Thrown when an export contradicts itself. Reading the rest again would
 * only hide it. */
class AlluviumExportInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlluviumExportInvalidError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must not be empty`);
  }
  return value;
}

function normalizeSource(value: AlluviumSourceIdentity): AlluviumSourceIdentity {
  return {
    id: nonEmpty(value.id, "Alluvium source ID"),
    epoch: nonEmpty(value.epoch, "Alluvium source epoch"),
  };
}

function normalizeEndpoint(
  value: string | URL | undefined,
  allowInsecureHttp: boolean,
): URL {
  const url = new URL(value ?? DEFAULT_ALLUVIUM_ENDPOINT);
  // Plain HTTP is for a service on this machine, or an explicit opt-in.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (allowInsecureHttp || loopback))
  ) {
    throw new TypeError("Alluvium endpoint must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Alluvium endpoint must be a plain origin or base path");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegative(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function excluded(patterns: string[], collection: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith(".*")
      ? collection.startsWith(pattern.slice(0, -1))
      : pattern === collection,
  );
}

function requestedCollections(collections: string[]): string[] {
  const unique = [...new Set(collections)].sort();
  if (unique.length === 0 || unique.length > MAX_COLLECTIONS) {
    throw new RangeError(`Alluvium exports 1-${MAX_COLLECTIONS} collections per bootstrap`);
  }
  for (const collection of unique) {
    if (!isNsid(collection)) {
      throw new TypeError(`Alluvium collection must be an exact NSID: ${collection}`);
    }
  }
  return unique;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function insertInitialStateStatement(
  db: Database,
  state: AlluviumBootstrapState,
): Statement {
  return db
    .prepare("INSERT INTO _contrail_meta (key, value) VALUES (?, ?)")
    .bind(ALLUVIUM_BOOTSTRAP_META_KEY, JSON.stringify(state));
}

function saveStateStatement(db: Database, state: AlluviumBootstrapState): Statement {
  return db
    .prepare(
      `INSERT INTO _contrail_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(ALLUVIUM_BOOTSTRAP_META_KEY, JSON.stringify(state));
}

/** Read a `_contrail_meta` value without swallowing database errors. */
async function readMetaStrict(db: Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM _contrail_meta WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

function isMissingLegacyBootstrapTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "42P01") return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no such table:\s*bootstrap_state/i.test(message) ||
    /relation "bootstrap_state" does not exist/i.test(message)
  );
}

/** Translate a completed pre-v0.32 `bootstrap_state` Alluvium row so existing
 * dev databases keep restarting cleanly under `contrail dev --alluvium`. */
async function readLegacyBootstrapState(
  db: Database,
): Promise<AlluviumBootstrapState | null> {
  let row: {
    phase: string;
    snapshot_json: string;
    capture_source: string;
    capture_epoch: string;
    capture_cursor: string;
    change_source: string | null;
    change_epoch: string | null;
    change_cursor: string | null;
    started_at: number | string;
    updated_at: number | string;
    finished_at: number | string | null;
  } | null;
  try {
    row = await db
      .prepare(
        `SELECT phase, snapshot_json, capture_source, capture_epoch, capture_cursor,
                change_source, change_epoch, change_cursor, started_at, updated_at, finished_at
         FROM bootstrap_state WHERE id = 1`,
      )
      .first();
  } catch (error) {
    if (isMissingLegacyBootstrapTable(error)) return null;
    throw error;
  }
  if (!row) return null;
  if (row.phase !== "complete") {
    throw new Error(
      "An interrupted bootstrap from an earlier Contrail version cannot be resumed; delete the database and start fresh.",
    );
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.snapshot_json);
  } catch {
    return null;
  }
  const data = object(snapshot) ? snapshot.providerData : undefined;
  if (
    !object(snapshot) ||
    snapshot.provider !== "alluvium" ||
    !object(data) ||
    data.v !== 4 ||
    typeof data.endpoint !== "string" ||
    !Array.isArray(data.collections) ||
    !data.collections.every((item) => typeof item === "string")
  ) {
    return null;
  }
  const sourceId = row.change_source ?? row.capture_source;
  const sourceEpoch = row.change_epoch ?? row.capture_epoch;
  return {
    v: 1,
    phase: "complete",
    endpoint: data.endpoint,
    source: { id: sourceId, epoch: sourceEpoch },
    collections: data.collections as string[],
    cursor: safeInteger(data.cursor, "Legacy Alluvium cursor"),
    timeUs: safeInteger(data.timeUs, "Legacy Alluvium timeUs"),
    liveCursorUs: safeInteger(data.liveCursorUs, "Legacy Alluvium liveCursorUs"),
    after: null,
    startedAt: safeInteger(Number(row.started_at), "Legacy Alluvium startedAt"),
    updatedAt: safeInteger(Number(row.updated_at), "Legacy Alluvium updatedAt"),
    ...(row.finished_at != null
      ? { finishedAt: safeInteger(Number(row.finished_at), "Legacy Alluvium finishedAt") }
      : {}),
  };
}

/** Read durable Alluvium bootstrap state from `_contrail_meta` (or a completed
 * legacy `bootstrap_state` row), if any. */
export async function getAlluviumBootstrapState(
  db: Database,
): Promise<AlluviumBootstrapState | null> {
  const raw = await readMetaStrict(db, ALLUVIUM_BOOTSTRAP_META_KEY);
  if (raw === null) return readLegacyBootstrapState(db);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Durable Alluvium bootstrap state is not valid JSON");
  }
  if (
    !object(parsed) ||
    parsed.v !== 1 ||
    (parsed.phase !== "loading" &&
      parsed.phase !== "rebuilding" &&
      parsed.phase !== "complete") ||
    typeof parsed.endpoint !== "string" ||
    !object(parsed.source) ||
    typeof parsed.source.id !== "string" ||
    typeof parsed.source.epoch !== "string" ||
    !Array.isArray(parsed.collections) ||
    !parsed.collections.every((item) => typeof item === "string") ||
    (parsed.after !== null && typeof parsed.after !== "string")
  ) {
    throw new Error("Durable Alluvium bootstrap state is malformed");
  }
  let rebuild: DerivedProjectionResumeCursor | null | undefined;
  if (parsed.rebuild !== undefined) {
    if (parsed.rebuild === null) {
      rebuild = null;
    } else if (
      object(parsed.rebuild) &&
      (parsed.rebuild.stage === "fts" || parsed.rebuild.stage === "counts") &&
      typeof parsed.rebuild.collection === "string" &&
      (parsed.rebuild.relation === undefined ||
        typeof parsed.rebuild.relation === "string") &&
      (parsed.rebuild.after === null || typeof parsed.rebuild.after === "string")
    ) {
      rebuild = {
        stage: parsed.rebuild.stage,
        collection: parsed.rebuild.collection,
        ...(parsed.rebuild.relation !== undefined
          ? { relation: parsed.rebuild.relation }
          : {}),
        after: parsed.rebuild.after,
      };
    } else {
      throw new Error("Durable Alluvium bootstrap rebuild cursor is malformed");
    }
  }
  return {
    v: 1,
    phase: parsed.phase,
    endpoint: parsed.endpoint,
    source: { id: parsed.source.id, epoch: parsed.source.epoch },
    collections: parsed.collections as string[],
    cursor: safeInteger(parsed.cursor, "Alluvium state cursor"),
    timeUs: safeInteger(parsed.timeUs, "Alluvium state timeUs"),
    liveCursorUs: safeInteger(parsed.liveCursorUs, "Alluvium state liveCursorUs"),
    after: parsed.after,
    ...(rebuild !== undefined ? { rebuild } : {}),
    startedAt: safeInteger(parsed.startedAt, "Alluvium state startedAt"),
    updatedAt: safeInteger(parsed.updatedAt, "Alluvium state updatedAt"),
    ...(parsed.finishedAt !== undefined
      ? { finishedAt: safeInteger(parsed.finishedAt, "Alluvium state finishedAt") }
      : {}),
  };
}

async function assertFreshBootstrapDatabase(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  const cursor = await getLastCursor(db);
  const versionRow = await db
    .prepare("SELECT COUNT(*) AS count FROM record_versions")
    .first<{ count: number | string }>();
  let visibleRecords = 0;
  for (const shortName of Object.keys(config.collections)) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${recordsTableName(shortName)}`)
      .first<{ count: number | string }>();
    visibleRecords += Number(row?.count ?? 0);
  }
  const versions = Number(versionRow?.count ?? 0);
  if (cursor !== null || versions > 0 || visibleRecords > 0) {
    throw new Error(
      "Alluvium bootstrap requires a fresh unpublished database. " +
        "Create or select a new database instead of resetting an active generation.",
    );
  }
}

/** Record, then drop, every plain secondary index on the tables a snapshot
 * writes. Unique indexes stay so upserts resolve conflicts on them. */
async function deferSecondaryIndexes(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  if (isPostgresDialect(getDialect(db))) return;
  if (await readMetaStrict(db, BOOTSTRAP_DEFERRED_INDEXES_META_KEY)) return;
  const tables = [
    ...Object.keys(config.collections).map(recordsTableName),
    "record_versions",
  ];
  const rows = await db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND sql IS NOT NULL
         AND tbl_name IN (${tables.map(() => "?").join(", ")})`,
    )
    .bind(...tables)
    .all<{ name: string; sql: string }>();
  const indexes = (rows.results ?? []).filter(
    (row) =>
      /^[A-Za-z0-9_]+$/.test(row.name) && !/^\s*CREATE\s+UNIQUE\b/i.test(row.sql),
  );
  if (indexes.length === 0) return;
  await setMeta(db, BOOTSTRAP_DEFERRED_INDEXES_META_KEY, JSON.stringify(indexes));
  for (const index of indexes) {
    await db.prepare(`DROP INDEX IF EXISTS ${index.name}`).run();
  }
}

/** Rebuild the indexes {@link deferSecondaryIndexes} dropped. */
async function restoreSecondaryIndexes(db: Database): Promise<void> {
  const recorded = await readMetaStrict(db, BOOTSTRAP_DEFERRED_INDEXES_META_KEY);
  if (!recorded) return;
  const indexes = JSON.parse(recorded) as Array<{ name: string; sql: string }>;
  for (const index of indexes) {
    const sql = /\bIF\s+NOT\s+EXISTS\b/i.test(index.sql)
      ? index.sql
      : index.sql.replace(/^\s*CREATE\s+INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ");
    await db.prepare(sql).run();
  }
  await db
    .prepare("DELETE FROM _contrail_meta WHERE key = ?")
    .bind(BOOTSTRAP_DEFERRED_INDEXES_META_KEY)
    .run();
}

function parseExportRecord(
  line: Record<string, unknown>,
  collections: ReadonlySet<string>,
): ExportRecord {
  const { uri, cid, record } = line;
  if (typeof uri !== "string" || !uri.startsWith("at://")) {
    throw new TypeError("Alluvium export line is not a record");
  }
  const [did, collection, rkey, ...extra] = uri.slice("at://".length).split("/");
  if (!did || !isDid(did)) throw new TypeError("Alluvium record has an invalid DID");
  if (!collection || !collections.has(collection)) {
    throw new TypeError(
      `Alluvium returned a record of an unrequested collection: ${String(collection)}`,
    );
  }
  if (!rkey || extra.length > 0 || !isRecordKey(rkey)) {
    throw new TypeError("Alluvium record has an invalid record key");
  }
  if (typeof cid !== "string" || !cid) throw new TypeError("Alluvium record has no CID");
  if (!object(record)) throw new TypeError("Alluvium record value must be an object");
  const timeUs = safeInteger(line.time_us, "Alluvium record time_us");
  return { uri, did, collection, rkey, cid, value: record, timeUs };
}

function parseJsonLine(text: string, maxLineCharacters: number): Record<string, unknown> {
  if (text.length > maxLineCharacters) {
    throw new TypeError("Alluvium export line exceeds the configured limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TypeError("Alluvium export line is not JSON", { cause: error });
  }
  if (!object(value)) throw new TypeError("Alluvium export line must be an object");
  return value;
}

async function* readJsonLines(
  response: Response,
  maxLineCharacters: number,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    throw new AlluviumExportInterruptedError("Alluvium export has no body");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  try {
    for (;;) {
      signal?.throwIfAborted();
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (error) {
        signal?.throwIfAborted();
        throw new AlluviumExportInterruptedError("Alluvium export connection failed", {
          cause: error,
        });
      }
      if (chunk.done) break;
      buffered += chunk.value;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const text = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (text) yield parseJsonLine(text, maxLineCharacters);
        newline = buffered.indexOf("\n");
      }
      if (buffered.length > maxLineCharacters) {
        throw new TypeError("Alluvium export line exceeds the configured limit");
      }
    }
    // A final line without a newline means the stream was cut mid-line.
    if (buffered) {
      throw new AlluviumExportInterruptedError("Alluvium export ended mid-line");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Load a fresh Contrail database from an Alluvium export and seed the live
 * Jetstream timestamp cursor just before the pinned export's head.
 *
 * Resumable across crashes or dropped HTTP streams: each projected batch
 * commits its records and `?after=<uri>` resume token in the same transaction.
 */
export async function loadAlluviumExport(
  db: Database,
  configInput: ContrailConfig,
  options: LoadAlluviumExportOptions = {},
): Promise<LoadAlluviumExportResult> {
  const config = (configInput as ResolvedContrailConfig)._resolved
    ? (configInput as ResolvedContrailConfig)
    : resolveConfig(configInput);
  const endpoint = normalizeEndpoint(
    options.endpoint,
    options.allowInsecureHttp === true,
  );
  const ordered = config.orderedSource;
  const source = normalizeSource(
    options.source ?? {
      id: ordered?.source ?? "jetstream",
      epoch: ordered?.epoch ?? "alluvium-export",
    },
  );
  if (ordered && (ordered.source !== source.id || ordered.epoch !== source.epoch)) {
    throw new Error(
      "Alluvium source ID/epoch must match the configured orderedSource",
    );
  }
  const collections = requestedCollections(
    options.collections ?? getDiscoverableNsids(config),
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const token = options.token;
  const rewindUs = nonNegative(
    options.rewindUs,
    DEFAULT_ALLUVIUM_REWIND_US,
    "Alluvium rewindUs",
  );
  const maxAgeUs = positiveInteger(
    options.maxAgeUs,
    DEFAULT_ALLUVIUM_MAX_AGE_US,
    "Alluvium maxAgeUs",
  );
  const replayWindowUs = positiveInteger(
    options.replayWindowUs,
    DEFAULT_ALLUVIUM_REPLAY_WINDOW_US,
    "Alluvium replayWindowUs",
  );
  const transport = options.transport ?? {};
  const maxAttempts = positiveInteger(
    transport.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    "Alluvium maxAttempts",
  );
  const requestTimeoutMs = positiveInteger(
    transport.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    "Alluvium requestTimeoutMs",
  );
  const maxLineCharacters = positiveInteger(
    transport.maxLineCharacters,
    DEFAULT_MAX_LINE_CHARACTERS,
    "Alluvium maxLineCharacters",
  );
  const batchSize = positiveInteger(
    transport.batchSize,
    DEFAULT_BATCH_SIZE,
    "Alluvium batchSize",
  );
  const rebuildChunkSize =
    options.rebuildChunkSize === 0 || options.rebuildChunkSize === undefined
      ? undefined
      : positiveInteger(
          options.rebuildChunkSize,
          DEFAULT_REBUILD_CHUNK_SIZE,
          "Alluvium rebuildChunkSize",
        );
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const logger = config.logger;
  const wallStarted = performance.now();
  let lastProgressLogAt = wallStarted;
  const emitProgress = (progress: AlluviumProgress): void => {
    if (options.onProgress) {
      options.onProgress(progress);
      return;
    }
    if (!logger) return;
    const current = performance.now();
    if (current - lastProgressLogAt >= PROGRESS_LOG_INTERVAL_MS) {
      lastProgressLogAt = current;
      const secs = (progress.elapsedMs / 1000).toFixed(1);
      if (progress.phase === "loading") {
        const rate =
          progress.elapsedMs > 0
            ? Math.round((progress.records * 1000) / progress.elapsedMs)
            : 0;
        logger.log(
          `[alluvium] loading: ${progress.records.toLocaleString("en-US")} records (${secs}s, ${rate.toLocaleString("en-US")} rec/s)`,
        );
      } else {
        const target = progress.relation
          ? `${progress.collection}.${progress.relation}`
          : progress.collection;
        logger.log(
          `[alluvium] rebuilding ${progress.stage} (${target}): ${progress.records.toLocaleString("en-US")} rows (${secs}s)`,
        );
      }
    }
  };

  const assertReplayable = (state: AlluviumBootstrapState): void => {
    const ageUs = now() * 1_000 - state.timeUs;
    if (ageUs > replayWindowUs) {
      throw new SourceHistoryExpiredError(
        `This Alluvium bootstrap was pinned ${Math.round(ageUs / 3_600_000_000)} hours ago; ` +
          "live ingestion can no longer replay from it. Start again with a fresh database.",
      );
    }
  };

  const open = async (url: URL): Promise<Response> => {
    // Keep the default Accept-Encoding (gzip); Node's fetch decodes only the
    // first frame of multi-frame zstd streams.
    const headers = new Headers({
      accept: "application/json, application/x-ndjson",
    });
    if (token) headers.set("authorization", `Bearer ${token}`);
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error("Alluvium request timed out")),
      requestTimeoutMs,
    );
    const onAbort = () => timeout.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    let response: Response;
    try {
      response = await fetchImpl(url, { headers, signal: timeout.signal });
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 200) {
      signal?.removeEventListener("abort", onAbort);
      await response.body?.cancel().catch(() => {});
      const error = new Error(
        `Alluvium ${url.pathname} returned HTTP ${response.status}`,
      );
      (error as Error & { retryable?: boolean }).retryable = retryableStatus(
        response.status,
      );
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return response;
  };

  const fetchHead = async (): Promise<AlluviumHead> => {
    const url = new URL("alluvium/head", endpoint);
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await delay(Math.min(1_000 * 2 ** (attempt - 1), 15_000), signal);
      }
      try {
        const body: unknown = await (await open(url)).json();
        if (!object(body)) throw new TypeError("Alluvium head must be an object");
        const excludes = Array.isArray(body.excludes) ? body.excludes : [];
        return {
          cursor: safeInteger(body.cursor, "Alluvium head cursor"),
          timeUs: safeInteger(body.time_us, "Alluvium head time_us"),
          excludes: excludes.filter((item): item is string => typeof item === "string"),
        };
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        if ((error as { retryable?: boolean }).retryable === false) break;
      }
    }
    const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`Alluvium head is unavailable${reason}`, { cause: lastError });
  };

  const prior = await getAlluviumBootstrapState(db);
  if (prior?.phase === "complete") {
    const handoff: SourcePosition = {
      source: prior.source.id,
      epoch: prior.source.epoch,
      cursor: String(prior.liveCursorUs),
    };
    const liveCursor = await getLastCursor(db);
    if (liveCursor === null) {
      throw new Error("Alluvium bootstrap did not persist its live cursor");
    }
    return {
      handoff,
      liveCursor,
      resumed: true,
      alreadyComplete: true,
      recordsLoaded: 0,
    };
  }

  let state: AlluviumBootstrapState;
  const resumed = prior !== null;
  if (prior) {
    if (prior.endpoint !== endpoint.href) {
      throw new Error("Bootstrap was pinned against a different Alluvium endpoint");
    }
    if (prior.source.id !== source.id || prior.source.epoch !== source.epoch) {
      throw new Error("Bootstrap was pinned against a different source identity");
    }
    if (
      prior.collections.length !== collections.length ||
      prior.collections.some((col, index) => col !== collections[index])
    ) {
      throw new Error("Bootstrap was pinned against a different collection set");
    }
    assertReplayable(prior);
    state = { ...prior };
  } else {
    await assertFreshBootstrapDatabase(db, config);
    const head = await fetchHead();
    for (const collection of collections) {
      if (excluded(head.excludes, collection)) {
        throw new Error(
          `Alluvium at ${endpoint.host} does not carry ${collection}; load it from PDSes instead`,
        );
      }
    }
    const ageUs = now() * 1_000 - head.timeUs;
    if (ageUs > maxAgeUs) {
      throw new Error(
        `Alluvium at ${endpoint.host} is serving a snapshot ${Math.round(ageUs / 60_000_000)} minutes old`,
      );
    }
    const liveCursorUs = head.timeUs - rewindUs;
    if (liveCursorUs < TIMESTAMP_CURSOR_MIN) {
      throw new Error("Alluvium has not ingested any events yet");
    }
    const startedAt = now();
    state = {
      v: 1,
      phase: "loading",
      endpoint: endpoint.href,
      source,
      collections,
      cursor: head.cursor,
      timeUs: head.timeUs,
      liveCursorUs,
      after: null,
      startedAt,
      updatedAt: startedAt,
    };
    await insertInitialStateStatement(db, state).run();
  }

  if (options.deferIndexes && state.phase === "loading") {
    await deferSecondaryIndexes(db, config);
  }

  const collectionSet = new Set(state.collections);
  const snapshotId = `alluvium:${endpoint.host}:${state.cursor}`;
  let recordsLoaded = 0;

  if (state.phase === "loading") {
    const knownDids =
      getDependentNsids(config).length > 0
        ? await loadKnownActorDids(db, config)
        : undefined;
    // On a fresh database, feed fan-out joins against each feed's follow table.
    // When none of the configured follow collections are in this export (e.g.
    // app.bsky.graph.follow, which Alluvium excludes), those tables stay empty
    // throughout the load so per-record fan-out statements would be pure no-ops.
    const hasExportedFollowCollection = Object.values(config.feeds ?? {}).some(
      (feedConfig) => {
        const followShort = feedConfig.follow ?? DEFAULT_FOLLOW_SHORT;
        const followNsid = nsidForShortName(config, followShort);
        return followNsid !== undefined && collectionSet.has(followNsid);
      },
    );

    const commitBatch = async (
      batch: ExportRecord[],
      sourceTimeUs: number,
      nextAfter: string | null,
      nextPhase: "loading" | "rebuilding" = "loading",
    ): Promise<void> => {
      const indexedAt = now() * 1_000;
      const events = batch.map((item) =>
        createIngestEvent({
          uri: item.uri,
          did: item.did,
          collection: item.collection,
          rkey: item.rkey,
          operation: "update",
          cid: item.cid,
          value: item.value,
          timeUs: recordTimeUs(item.value, item.collection, config, item.timeUs),
          indexedAt,
          source: {
            id: "snapshot:alluvium",
            epoch: snapshotId,
            time_us: sourceTimeUs,
            revision: null,
            cursor: nextAfter ?? "export",
          },
        }),
      );
      const nextState: AlluviumBootstrapState = {
        ...state,
        phase: nextPhase,
        after: nextPhase === "rebuilding" ? null : nextAfter,
        ...(nextPhase === "rebuilding" ? { rebuild: null } : {}),
        updatedAt: now(),
      };
      const result = await ingestRecords(db, events, config, {
        knownDids,
        skipDerivedProjections: true,
        skipFeedFanout: !hasExportedFollowCollection,
        authoritativeSourceObservation: true,
        freshBulkLoad: true,
        trailingStatements: [saveStateStatement(db, nextState)],
      });
      state = nextState;
      if (knownDids) {
        for (const did of result.discoveredDids) knownDids.add(did);
      }
      recordsLoaded += batch.length;
      emitProgress({
        phase: "loading",
        records: recordsLoaded,
        elapsedMs: Math.round(performance.now() - wallStarted),
      });
    };

    let after = state.after;
    let records: ExportRecord[] = [];
    let batchTimeUs = state.liveCursorUs;
    let lastError: unknown;
    let completedStream = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await delay(Math.min(1_000 * 2 ** (attempt - 1), 15_000), signal);
      }
      assertReplayable(state);
      const url = new URL("export", endpoint);
      for (const collection of state.collections) {
        url.searchParams.append("collection", collection);
      }
      if (after) url.searchParams.set("after", after);

      let lines: AsyncGenerator<Record<string, unknown>>;
      try {
        const response = await open(url);
        // Live ingestion replays from the pinned snapshot's time, so an export
        // of an older snapshot (rollback or lagging replica) would leave a gap.
        const header = response.headers.get("alluvium-time-us");
        const servedUs = header && /^\d+$/.test(header) ? Number(header) : null;
        if (
          servedUs === null ||
          !Number.isSafeInteger(servedUs) ||
          servedUs < state.timeUs
        ) {
          await response.body?.cancel().catch(() => {});
          throw new Error(
            servedUs === null
              ? "Alluvium export did not say which snapshot it serves"
              : "Alluvium served an export older than the snapshot this bootstrap pinned",
          );
        }
        lines = readJsonLines(response, maxLineCharacters, signal);
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        if ((error as { retryable?: boolean }).retryable === false) break;
        continue;
      }

      let received = 0;
      let commitError: unknown;
      const runCommit = async (
        batch: ExportRecord[],
        sourceTimeUs: number,
        nextAfter: string | null,
        nextPhase: "loading" | "rebuilding" = "loading",
      ): Promise<void> => {
        try {
          await commitBatch(batch, sourceTimeUs, nextAfter, nextPhase);
        } catch (error) {
          commitError = error;
          throw error;
        }
      };
      try {
        for await (const line of lines) {
          if (line.end === true) {
            if (safeInteger(line.records, "Alluvium export record count") !== received) {
              throw new AlluviumExportInvalidError(
                "Alluvium export ended with a different record count than it sent",
              );
            }
            if (records.length > 0) {
              await runCommit(records, batchTimeUs, after, "rebuilding");
              records = [];
              batchTimeUs = state.liveCursorUs;
            } else {
              try {
                state = {
                  ...state,
                  phase: "rebuilding",
                  after: null,
                  rebuild: null,
                  updatedAt: now(),
                };
                await saveStateStatement(db, state).run();
              } catch (error) {
                commitError = error;
                throw error;
              }
            }
            completedStream = true;
            break;
          }
          const item = parseExportRecord(line, collectionSet);
          received += 1;
          records.push(item);
          // A batch is ordered against later changes by one time, so it takes the
          // oldest of its records' and never exceeds the live replay cursor.
          batchTimeUs = Math.min(batchTimeUs, item.timeUs);
          after = item.uri;
          if (records.length >= batchSize) {
            await runCommit(records, batchTimeUs, after);
            records = [];
            batchTimeUs = state.liveCursorUs;
            // Progress resets the retry budget: only consecutive failures count.
            attempt = 0;
          }
        }
        if (completedStream) break;
        throw new AlluviumExportInterruptedError(
          "Alluvium export ended before its closing line",
        );
      } catch (error) {
        if (commitError !== undefined && error === commitError) {
          // Database/projection failures must surface immediately rather than
          // retrying the HTTP export as if it were a network interruption.
          throw error;
        }
        signal?.throwIfAborted();
        if (
          error instanceof AlluviumExportInvalidError ||
          (!(error instanceof AlluviumExportInterruptedError) &&
            error instanceof TypeError)
        ) {
          // Malformed data will not improve on retry.
          throw error;
        }
        lastError = error;
        // Uncommitted records stay buffered while `after` already points past
        // them, so the next attempt continues without duplicating them.
      }
    }

    if (!completedStream) {
      const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
      throw new Error(`Alluvium export did not complete${reason}`, {
        cause: lastError,
      });
    }
  }

  assertReplayable(state);
  await restoreSecondaryIndexes(db);
  await rebuildDerivedProjections(
    db,
    config,
    rebuildChunkSize !== undefined
      ? {
          chunkSize: rebuildChunkSize,
          resume: state.rebuild ?? null,
          checkpointStatement: (cursor) =>
            saveStateStatement(db, {
              ...state,
              rebuild: cursor,
              updatedAt: now(),
            }),
          onProgress: (progress) => {
            emitProgress({
              phase: "rebuilding",
              records: progress.processed,
              elapsedMs: Math.round(performance.now() - wallStarted),
              stage: progress.stage,
              collection: progress.collection,
              relation: progress.relation,
            });
          },
        }
      : {},
  );

  const handoff: SourcePosition = {
    source: state.source.id,
    epoch: state.source.epoch,
    cursor: String(state.liveCursorUs),
  };
  const finishedAt = now();
  state = {
    ...state,
    phase: "complete",
    after: null,
    rebuild: null,
    updatedAt: finishedAt,
    finishedAt,
  };
  await db.batch([
    saveServingSourcePositionStatement(db, handoff),
    saveCursorStatement(db, state.liveCursorUs),
    saveStateStatement(db, state),
  ]);

  return {
    handoff,
    liveCursor: state.liveCursorUs,
    resumed,
    alreadyComplete: false,
    recordsLoaded,
  };
}
