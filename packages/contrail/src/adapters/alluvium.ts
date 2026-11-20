import { isDid, isNsid, isRecordKey } from "@atcute/lexicons/syntax";
import type {
  ChangeSource,
  CollectionCoverage,
  MutationBatch,
  PreparedSnapshot,
  SnapshotBatch,
  SnapshotProgress,
  SnapshotRecord,
  SnapshotSource,
  SourcePosition,
  SourceSemantics,
} from "../core/sources";
import { SourceHistoryExpiredError } from "../core/jetstream-source";
import type { ContrailConfig } from "../core/types";

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

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_CHARACTERS = 2 * 1024 * 1024;
const MAX_COLLECTIONS = 100;
const EXPORT_PARTITION = "export";
const PROVIDER = "alluvium";
/** Jetstream v2 reads cursors at or above this as unix-microsecond times. */
const TIMESTAMP_CURSOR_MIN = 1_000_000_000_000_000;

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

export interface AlluviumBootstrapSourceOptions {
  /** Alluvium HTTP origin. Default: {@link DEFAULT_ALLUVIUM_ENDPOINT}. */
  endpoint?: string | URL;
  source: AlluviumSourceIdentity;
  /** Bearer token, when the service requires one. */
  token?: string;
  /** Default: {@link DEFAULT_ALLUVIUM_REWIND_US}. */
  rewindUs?: number;
  /** Default: {@link DEFAULT_ALLUVIUM_MAX_AGE_US}. */
  maxAgeUs?: number;
  /** Default: {@link DEFAULT_ALLUVIUM_REPLAY_WINDOW_US}. */
  replayWindowUs?: number;
  transport?: AlluviumTransportOptions;
  fetch?: typeof fetch;
  /** Permit HTTP to a non-loopback host. Loopback endpoints never need it.
   * Default: false. */
  allowInsecureHttp?: boolean;
  /** Clock override for tests. */
  now?: () => number;
}

export interface AlluviumBootstrapSources {
  snapshotSource: AlluviumSnapshotSource;
  changeSource: AlluviumChangeSource;
}

/** What `GET /alluvium/head` reports about the snapshot being served. */
interface AlluviumHead {
  /** Sequence number, on the service's own Jetstream, of the last event the
   * snapshot includes. */
  cursor: number;
  /** When that event was witnessed, in unix microseconds. */
  timeUs: number;
  /** Collections the service does not carry: exact NSIDs or `prefix.*`. */
  excludes: string[];
}

interface PinnedExport {
  v: 4;
  endpoint: string;
  collections: string[];
  /** Service sequence number when the export was pinned; informational. */
  cursor: number;
  /** When the pinned snapshot's last event was witnessed. Every export read
   * for this bootstrap must reach at least this far. */
  timeUs: number;
  /** Timestamp cursor live ingestion resumes from. */
  liveCursorUs: number;
}

/** The export holds current state only; replay semantics describe the live
 * stream that takes over from it. Account lifecycle and repository
 * replacement are already folded into the export but are not replayed. */
const semantics: SourceSemantics = {
  ordinaryRecords: true,
  ordinaryDeletes: true,
  accountLifecycle: false,
  repositoryReplacement: false,
  verifiedCommits: false,
  explicitHead: true,
};

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

class AlluviumAdapterBase {
  readonly id = PROVIDER;
  protected readonly endpoint: URL;
  protected readonly source: AlluviumSourceIdentity;
  protected readonly fetchImpl: typeof fetch;
  protected readonly token: string | undefined;
  protected readonly rewindUs: number;
  protected readonly maxAgeUs: number;
  protected readonly replayWindowUs: number;
  protected readonly maxAttempts: number;
  protected readonly requestTimeoutMs: number;
  protected readonly maxLineCharacters: number;
  protected readonly batchSize: number;
  protected readonly now: () => number;

  constructor(options: AlluviumBootstrapSourceOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint, options.allowInsecureHttp === true);
    this.source = normalizeSource(options.source);
    this.fetchImpl = options.fetch ?? fetch;
    this.token = options.token;
    this.rewindUs = nonNegative(options.rewindUs, DEFAULT_ALLUVIUM_REWIND_US, "Alluvium rewindUs");
    this.maxAgeUs = positiveInteger(options.maxAgeUs, DEFAULT_ALLUVIUM_MAX_AGE_US, "Alluvium maxAgeUs");
    this.replayWindowUs = positiveInteger(
      options.replayWindowUs,
      DEFAULT_ALLUVIUM_REPLAY_WINDOW_US,
      "Alluvium replayWindowUs",
    );
    const transport = options.transport ?? {};
    this.maxAttempts = positiveInteger(transport.maxAttempts, DEFAULT_MAX_ATTEMPTS, "Alluvium maxAttempts");
    this.requestTimeoutMs = positiveInteger(
      transport.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "Alluvium requestTimeoutMs",
    );
    this.maxLineCharacters = positiveInteger(
      transport.maxLineCharacters,
      DEFAULT_MAX_LINE_CHARACTERS,
      "Alluvium maxLineCharacters",
    );
    this.batchSize = positiveInteger(transport.batchSize, DEFAULT_BATCH_SIZE, "Alluvium batchSize");
    this.now = options.now ?? Date.now;
  }

  protected position(cursorUs: number): SourcePosition {
    return { source: this.source.id, epoch: this.source.epoch, cursor: String(cursorUs) };
  }

  protected assertOwnPosition(position: SourcePosition, label: string): void {
    if (position.source !== this.source.id || position.epoch !== this.source.epoch) {
      throw new Error(`${label} does not belong to ${this.source.id}/${this.source.epoch}`);
    }
  }

  /** Refuse to continue a bootstrap whose live cursor may have left the live
   * service's retention. Records already loaded would then miss the updates
   * and deletes since, so the only sound continuation is a fresh load. */
  protected assertReplayable(pinned: PinnedExport): void {
    const ageUs = this.now() * 1_000 - pinned.timeUs;
    if (ageUs > this.replayWindowUs) {
      throw new SourceHistoryExpiredError(
        `This Alluvium bootstrap was pinned ${Math.round(ageUs / 3_600_000_000)} hours ago; ` +
          "live ingestion can no longer replay from it. Start again with a fresh database.",
      );
    }
  }

  /** Open a response, failing on anything but 200. The timeout covers the
   * wait for headers only; an export body streams for as long as it needs. */
  protected async open(url: URL, signal?: AbortSignal): Promise<Response> {
    // The default Accept-Encoding stays: the service answers it with gzip.
    // It can also send its zstd frames as stored, but Node's fetch (24.15)
    // decodes only the first frame of such a stream.
    const headers = new Headers({ accept: "application/json, application/x-ndjson" });
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error("Alluvium request timed out")),
      this.requestTimeoutMs,
    );
    const onAbort = () => timeout.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, signal: timeout.signal });
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    // The caller's signal keeps governing the body; the header timer is done.
    if (response.status !== 200) {
      signal?.removeEventListener("abort", onAbort);
      await response.body?.cancel().catch(() => {});
      const error = new Error(`Alluvium ${url.pathname} returned HTTP ${response.status}`);
      (error as Error & { retryable?: boolean }).retryable = retryableStatus(response.status);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return response;
  }

  /** Read the service's current head, retrying transient failures. */
  protected async head(signal?: AbortSignal): Promise<AlluviumHead> {
    const url = new URL("alluvium/head", this.endpoint);
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) await delay(Math.min(1_000 * 2 ** (attempt - 1), 15_000), signal);
      try {
        const body: unknown = await (await this.open(url, signal)).json();
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
  }

  /** The timestamp cursor that replays everything a head could have missed. */
  protected liveCursorUs(head: AlluviumHead): number {
    const cursorUs = head.timeUs - this.rewindUs;
    if (cursorUs < TIMESTAMP_CURSOR_MIN) {
      throw new Error("Alluvium has not ingested any events yet");
    }
    return cursorUs;
  }
}

function parsePinned(snapshot: PreparedSnapshot): PinnedExport {
  const data = snapshot.providerData;
  if (
    snapshot.provider !== PROVIDER ||
    !object(data) ||
    data.v !== 4 ||
    typeof data.endpoint !== "string" ||
    !Array.isArray(data.collections) ||
    !data.collections.every((item) => typeof item === "string")
  ) {
    throw new Error(`Snapshot ${snapshot.id} was not prepared by this Alluvium adapter`);
  }
  return {
    v: 4,
    endpoint: data.endpoint,
    collections: data.collections as string[],
    cursor: safeInteger(data.cursor, "Pinned Alluvium cursor"),
    timeUs: safeInteger(data.timeUs, "Pinned Alluvium time"),
    liveCursorUs: safeInteger(data.liveCursorUs, "Pinned Alluvium live cursor"),
  };
}

/** One line of an export: a record, with the time the service witnessed
 * this version of it. Its URI is also the position to resume after. */
function exportRecord(
  line: Record<string, unknown>,
  collections: ReadonlySet<string>,
): { record: SnapshotRecord; timeUs: number } {
  const { uri, cid, record } = line;
  if (typeof uri !== "string" || !uri.startsWith("at://")) {
    throw new TypeError("Alluvium export line is not a record");
  }
  const [did, collection, rkey, ...extra] = uri.slice("at://".length).split("/");
  if (!did || !isDid(did)) throw new TypeError("Alluvium record has an invalid DID");
  if (!collection || !collections.has(collection)) {
    throw new TypeError(`Alluvium returned a record of an unrequested collection: ${String(collection)}`);
  }
  if (!rkey || extra.length > 0 || !isRecordKey(rkey)) {
    throw new TypeError("Alluvium record has an invalid record key");
  }
  if (typeof cid !== "string" || !cid) throw new TypeError("Alluvium record has no CID");
  if (!object(record)) throw new TypeError("Alluvium record value must be an object");
  const timeUs = safeInteger(line.time_us, "Alluvium record time_us");
  return {
    record: { uri, did, collection, rkey, cid, value: record, timeUs },
    timeUs,
  };
}

/**
 * Current-state snapshot from an Alluvium export.
 *
 * One request streams every record of the selected collections as of the
 * service's latest snapshot. It is resumable by record: a dropped connection
 * or a restarted process continues after the last record it projected.
 * Records read after a resume may come from a newer snapshot than those read
 * before it; that is sound because live ingestion then replays from before
 * the first snapshot's time, which brings every record to the same final
 * state.
 */
export class AlluviumSnapshotSource extends AlluviumAdapterBase implements SnapshotSource {
  async prepare(options: {
    collections: string[];
    signal?: AbortSignal;
  }): Promise<PreparedSnapshot> {
    const collections = requestedCollections(options.collections);
    const head = await this.head(options.signal);
    for (const collection of collections) {
      if (excluded(head.excludes, collection)) {
        throw new Error(
          `Alluvium at ${this.endpoint.host} does not carry ${collection}; load it from PDSes instead`,
        );
      }
    }
    const ageUs = this.now() * 1_000 - head.timeUs;
    if (ageUs > this.maxAgeUs) {
      throw new Error(
        `Alluvium at ${this.endpoint.host} is serving a snapshot ${Math.round(ageUs / 60_000_000)} minutes old`,
      );
    }
    const pinned: PinnedExport = {
      v: 4,
      endpoint: this.endpoint.href,
      collections,
      cursor: head.cursor,
      timeUs: head.timeUs,
      liveCursorUs: this.liveCursorUs(head),
    };
    const coverage: Record<string, CollectionCoverage> = {};
    for (const collection of collections) coverage[collection] = { state: "complete" };
    return {
      id: `alluvium:${this.endpoint.host}:${head.cursor}`,
      provider: PROVIDER,
      // Each response is one snapshot, but a resumed export can span
      // several, and the live replay is what reconciles them.
      consistency: "sampled-current-state",
      collections: coverage,
      semantics,
      providerData: pinned,
    };
  }

  async *read(options: {
    snapshot: PreparedSnapshot;
    progress?: SnapshotProgress[];
    signal?: AbortSignal;
  }): AsyncIterable<SnapshotBatch> {
    const pinned = parsePinned(options.snapshot);
    if (pinned.endpoint !== this.endpoint.href) {
      throw new Error("Snapshot was pinned against a different Alluvium endpoint");
    }
    const prior = options.progress?.find((item) => item.partition === EXPORT_PARTITION);
    if (prior?.complete) return;
    this.assertReplayable(pinned);
    const collections = new Set(pinned.collections);

    let after = prior?.cursor ?? null;
    let records: SnapshotRecord[] = [];
    let batchTimeUs = pinned.liveCursorUs;
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) await delay(Math.min(1_000 * 2 ** (attempt - 1), 15_000), options.signal);
      const url = new URL("export", this.endpoint);
      for (const collection of pinned.collections) url.searchParams.append("collection", collection);
      if (after) url.searchParams.set("after", after);

      let lines: AsyncGenerator<Record<string, unknown>>;
      try {
        const response = await this.open(url, options.signal);
        // Before any row is projected: live ingestion replays from the
        // pinned snapshot's time, so an export of an older snapshot (a
        // rollback, a replica that is behind) would leave a gap. A newer
        // one is fine, and the pinned handoff stays as it is.
        const header = response.headers.get("alluvium-time-us");
        const servedUs = header && /^\d+$/.test(header) ? Number(header) : null;
        if (servedUs === null || !Number.isSafeInteger(servedUs) || servedUs < pinned.timeUs) {
          await response.body?.cancel().catch(() => {});
          throw new Error(
            servedUs === null
              ? "Alluvium export did not say which snapshot it serves"
              : "Alluvium served an export older than the snapshot this bootstrap pinned",
          );
        }
        lines = this.lines(response, options.signal);
      } catch (error) {
        options.signal?.throwIfAborted();
        lastError = error;
        if ((error as { retryable?: boolean }).retryable === false) break;
        continue;
      }

      let received = 0;
      try {
        for await (const line of lines) {
          if (line.end === true) {
            if (safeInteger(line.records, "Alluvium export record count") !== received) {
              throw new AlluviumExportInvalidError(
                "Alluvium export ended with a different record count than it sent",
              );
            }
            yield {
              records,
              sourceTimeUs: batchTimeUs,
              progress: { partition: EXPORT_PARTITION, cursor: null, complete: true },
              done: true,
            };
            return;
          }
          const item = exportRecord(line, collections);
          received += 1;
          records.push(item.record);
          // A batch is ordered against later changes by one time, so it
          // takes the oldest of its records': none may look newer than it is.
          // Each record keeps its own time for its place in query order.
          batchTimeUs = Math.min(batchTimeUs, item.timeUs);
          after = item.record.uri;
          if (records.length >= this.batchSize) {
            yield {
              records,
              sourceTimeUs: batchTimeUs,
              progress: { partition: EXPORT_PARTITION, cursor: after, complete: false },
              done: false,
            };
            records = [];
            batchTimeUs = pinned.liveCursorUs;
            // Progress resets the retry budget: only consecutive failures count.
            attempt = 0;
          }
        }
        throw new AlluviumExportInterruptedError("Alluvium export ended before its closing line");
      } catch (error) {
        options.signal?.throwIfAborted();
        if (
          error instanceof AlluviumExportInvalidError ||
          (!(error instanceof AlluviumExportInterruptedError) && error instanceof TypeError)
        ) {
          // Malformed data will not improve on retry.
          throw error;
        }
        lastError = error;
        // Records received but not yet yielded stay buffered; `after` already
        // points past them, so the next attempt continues from there.
      }
    }
    const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`Alluvium export did not complete${reason}`, { cause: lastError });
  }

  /** Split a response body into parsed JSON lines. */
  private async *lines(
    response: Response,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    if (!response.body) throw new AlluviumExportInterruptedError("Alluvium export has no body");
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
          if (text) yield this.parseLine(text);
          newline = buffered.indexOf("\n");
        }
        if (buffered.length > this.maxLineCharacters) {
          throw new TypeError("Alluvium export line exceeds the configured limit");
        }
      }
      // A final line without a newline means the stream was cut mid-line.
      if (buffered) throw new AlluviumExportInterruptedError("Alluvium export ended mid-line");
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  private parseLine(text: string): Record<string, unknown> {
    if (text.length > this.maxLineCharacters) {
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
}

/**
 * Hand-off from an Alluvium export to live ingestion.
 *
 * The export already contains every change up to its snapshot, so there is
 * nothing to replay during bootstrap. This source only fixes the
 * two coordinates the coordinator needs: where capture began, and the
 * timestamp cursor live ingestion resumes from. Both are times, not sequence
 * numbers, so the live service can be any Jetstream instance.
 */
export class AlluviumChangeSource extends AlluviumAdapterBase implements ChangeSource {
  readonly semantics = semantics;

  constructor(_config: ContrailConfig, options: AlluviumBootstrapSourceOptions) {
    super(options);
  }

  async mark(options: {
    collections: string[];
    snapshot?: PreparedSnapshot;
    signal?: AbortSignal;
  }): Promise<SourcePosition> {
    if (options.snapshot) {
      const pinned = parsePinned(options.snapshot);
      this.assertReplayable(pinned);
      return this.position(pinned.liveCursorUs);
    }
    // Strictly before any snapshot pinned afterwards, whose live cursor is
    // computed from a head at least as new as this one.
    return this.position(this.liveCursorUs(await this.head(options.signal)) - 1);
  }

  async *read(options: {
    collections: string[];
    snapshot?: PreparedSnapshot;
    after: SourcePosition;
    through: SourcePosition;
    signal?: AbortSignal;
  }): AsyncIterable<MutationBatch> {
    this.assertOwnPosition(options.after, "Alluvium catch-up cursor");
    this.assertOwnPosition(options.through, "Alluvium catch-up target");
    // The last step before the handoff is persisted as the live cursor.
    if (options.snapshot) this.assertReplayable(parsePinned(options.snapshot));
    yield { mutations: [], checkpoint: options.through, caughtUp: true };
  }
}

/** Map the final bootstrap checkpoint to the timestamp cursor ordinary
 * scheduled ingestion resumes from. */
export function createAlluviumLiveCursor(
  source: AlluviumSourceIdentity,
): (position: SourcePosition) => number {
  const expected = normalizeSource(source);
  return (position) => {
    if (position.source !== expected.id || position.epoch !== expected.epoch) {
      throw new Error("Alluvium live cursor belongs to a different source");
    }
    const cursor = Number(position.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < TIMESTAMP_CURSOR_MIN) {
      throw new TypeError("Alluvium live cursor must be a microsecond timestamp");
    }
    return cursor;
  };
}

/** Create the paired Alluvium snapshot and hand-off sources. */
export function createAlluviumBootstrapSources(
  config: ContrailConfig,
  options: AlluviumBootstrapSourceOptions,
): AlluviumBootstrapSources {
  return {
    snapshotSource: new AlluviumSnapshotSource(options),
    changeSource: new AlluviumChangeSource(config, options),
  };
}
