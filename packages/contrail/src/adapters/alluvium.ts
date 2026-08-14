import { isDid, isNsid, isRecordKey } from "@atcute/lexicons/syntax";
import { JetstreamChangeSource, type JetstreamChangeSourceOptions } from "../core/jetstream-source";
import type {
  ChangeSource,
  CollectionCoverage,
  MutationBatch,
  PreparedSnapshot,
  SnapshotBatch,
  SnapshotProgress,
  SnapshotRecord,
  SnapshotSource,
  SourceMutation,
  SourcePosition,
  SourceSemantics,
} from "../core/sources";
import type { ContrailConfig } from "../core/types";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COMPRESSED_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_LINE_CHARACTERS = 2 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_MUTATIONS = 100_000;
const MAX_COLLECTIONS = 64;
const MAX_OBJECTS = 20_000;

export interface AlluviumSourceIdentity {
  /** Logical source ID shared by archived and direct Jetstream mutations. */
  id: string;
  /** Operator-owned continuity epoch. Protocol v1 does not publish one yet. */
  epoch: string;
  /** Exact Jetstream URL advertised by every selected manifest. */
  url: string;
}

export interface AlluviumTransportOptions {
  maxAttempts?: number;
  requestTimeoutMs?: number;
  maxCompressedBytes?: number;
  maxLineCharacters?: number;
  /** Maximum archived mutations retained for the protocol-v1 global ordering
   * pass. Default: 100,000. */
  maxArchiveMutations?: number;
  batchSize?: number;
}

export interface AlluviumBootstrapSourceOptions {
  endpoint: string | URL;
  source: AlluviumSourceIdentity;
  /** Direct Jetstream options used only to obtain the preliminary capture mark. */
  jetstream: Omit<JetstreamChangeSourceOptions, "sourceId" | "epoch">;
  transport?: AlluviumTransportOptions;
  fetch?: typeof fetch;
  /** Permit HTTP only for controlled local development. Default: false. */
  allowInsecureHttp?: boolean;
}

export interface AlluviumBootstrapSources {
  snapshotSource: AlluviumSnapshotSource;
  changeSource: AlluviumChangeSource;
}

/** Build the numeric-cursor mapping used by `DatabaseBootstrapTarget` so the
 * final archived Alluvium checkpoint becomes the starting cursor for ordinary
 * bounded cron ingestion. */
export function createAlluviumLiveCursor(
  source: AlluviumSourceIdentity,
): (position: SourcePosition) => number {
  const expected = normalizeSource(source);
  return (position) => cursorNumber(position, expected, "Alluvium live cursor");
}

export interface AlluviumBasePart {
  part: number;
  url: string;
  checksum: string;
  records: number;
  compressedBytes: number;
}

export interface AlluviumHistoricalCoverage {
  scope: "configured-relays";
  status: "complete" | "incomplete" | "unknown";
  accountsDiscovered: number;
  accountsIncluded: number;
  accountsOmitted: number;
  report: null | {
    url: string;
    checksum: string;
    compressedBytes: number;
    mediaType: "application/gzip";
  };
}

export interface AlluviumTailObject {
  run: number;
  firstRun?: number;
  lastRun?: number;
  level?: "raw" | "hour" | "six-hour" | "day";
  part: number;
  firstTimeUs: number;
  lastTimeUs: number;
  url: string;
  checksum: string;
  events: number;
  compressedBytes: number;
}

export interface AlluviumCollectionManifest {
  format: "alluvium.collection";
  version: 1;
  collection: string;
  state: "pending_capture" | "capturing" | "backfilling" | "active" | "gap" | "paused" | "error";
  source: {
    id: string;
    protocol: "jetstream-v1";
    url: string;
    archivedThroughTimeUs: number;
  };
  semantics: {
    operations: ["put", "delete"];
    accountDeletion: false;
    repositorySync: false;
    physicalPayloadDeletion: false;
  };
  coverage: {
    captureFromRun: number | null;
    captureFromTimeUs: number | null;
    capturedThroughRun: number;
    capturedThroughTimeUs: number;
    knownGaps: number;
    historicalBootstrap: "current-records-from-pds";
  };
  base: {
    generation: number;
    throughRun: number;
    throughTimeUs: number;
    url: string;
    checksum: string;
    records: number;
    compressedBytes: number;
    seedKind: "backfill" | "fold" | "rebuild";
    historicalCoverage: AlluviumHistoricalCoverage;
    parts: AlluviumBasePart[];
  };
  tail: AlluviumTailObject[];
}

interface PinnedAlluviumData {
  format: "contrail.alluvium-snapshot";
  version: 1;
  endpoint: string;
  source: AlluviumSourceIdentity;
  archiveThrough: {
    run: number;
    timeUs: number;
  };
  manifests: Record<string, AlluviumCollectionManifest>;
}

interface TransportPolicy {
  maxAttempts: number;
  requestTimeoutMs: number;
  maxCompressedBytes: number;
  maxLineCharacters: number;
  maxArchiveMutations: number;
  batchSize: number;
}

interface AlluviumBaseRecord {
  v: 1;
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  cid: string;
  record: unknown;
}

interface AlluviumPutEvent {
  v: 1;
  run: number;
  timeUs: number;
  source: string;
  op: "put";
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  rev?: string;
  cid: string;
  record: unknown;
}

interface AlluviumDeleteEvent {
  v: 1;
  run: number;
  timeUs: number;
  source: string;
  op: "delete";
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  rev?: string;
}

type AlluviumDeltaEvent = AlluviumPutEvent | AlluviumDeleteEvent;

const semantics: SourceSemantics = {
  ordinaryRecords: true,
  ordinaryDeletes: true,
  accountLifecycle: false,
  repositoryReplacement: false,
  verifiedCommits: false,
  explicitHead: true,
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = safeInteger(value, label);
  if (parsed < 1) throw new TypeError(`${label} must be positive`);
  return parsed;
}

function string(value: unknown, label: string, max = 2_048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function checksum(value: unknown, label: string): string {
  const parsed = string(value, label, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) {
    throw new TypeError(`${label} is not a SHA-256 checksum`);
  }
  return parsed;
}

function exactUri(
  uri: unknown,
  did: unknown,
  collection: unknown,
  rkey: unknown,
  label: string,
): { uri: string; did: string; collection: string; rkey: string } {
  const parsedDid = string(did, `${label}.did`, 2_048);
  const parsedCollection = string(collection, `${label}.collection`, 317);
  const parsedRkey = string(rkey, `${label}.rkey`, 512);
  const parsedUri = string(uri, `${label}.uri`, 4_096);
  if (!isDid(parsedDid) || !isNsid(parsedCollection) || !isRecordKey(parsedRkey)) {
    throw new TypeError(`${label} has an invalid AT Protocol identifier`);
  }
  if (parsedUri !== `at://${parsedDid}/${parsedCollection}/${parsedRkey}`) {
    throw new TypeError(`${label}.uri disagrees with its DID, collection, or rkey`);
  }
  return {
    uri: parsedUri,
    did: parsedDid,
    collection: parsedCollection,
    rkey: parsedRkey,
  };
}

function transportPolicy(value: AlluviumTransportOptions = {}): TransportPolicy {
  const policy = {
    maxAttempts: value.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    requestTimeoutMs: value.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxCompressedBytes: value.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES,
    maxLineCharacters: value.maxLineCharacters ?? DEFAULT_MAX_LINE_CHARACTERS,
    maxArchiveMutations: value.maxArchiveMutations ?? DEFAULT_MAX_ARCHIVE_MUTATIONS,
    batchSize: value.batchSize ?? DEFAULT_BATCH_SIZE,
  };
  positiveInteger(policy.maxAttempts, "transport.maxAttempts");
  positiveInteger(policy.requestTimeoutMs, "transport.requestTimeoutMs");
  positiveInteger(policy.maxCompressedBytes, "transport.maxCompressedBytes");
  positiveInteger(policy.maxLineCharacters, "transport.maxLineCharacters");
  positiveInteger(policy.maxArchiveMutations, "transport.maxArchiveMutations");
  positiveInteger(policy.batchSize, "transport.batchSize");
  if (policy.maxAttempts > 10) throw new TypeError("transport.maxAttempts cannot exceed 10");
  if (policy.batchSize > 1_000) throw new TypeError("transport.batchSize cannot exceed 1000");
  return policy;
}

function normalizeEndpoint(value: string | URL, allowInsecureHttp: boolean): URL {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError("Alluvium endpoint cannot include credentials, search, or a fragment");
  }
  if (endpoint.protocol !== "https:" && !(allowInsecureHttp && endpoint.protocol === "http:")) {
    throw new TypeError("Alluvium endpoint must use HTTPS");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/";
  return endpoint;
}

function normalizeSource(value: AlluviumSourceIdentity): AlluviumSourceIdentity {
  const id = string(value.id, "source.id", 128);
  const epoch = string(value.epoch, "source.epoch", 128);
  const url = new URL(string(value.url, "source.url", 2_048));
  if (url.protocol !== "wss:") throw new TypeError("Alluvium source URL must use WSS");
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Alluvium source URL cannot include credentials, search, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return { id, epoch, url: url.href.replace(/\/$/, "") };
}

function sourcePosition(source: AlluviumSourceIdentity, cursor: number): SourcePosition {
  return { source: source.id, epoch: source.epoch, cursor: String(cursor) };
}

function cursorNumber(position: SourcePosition, source: AlluviumSourceIdentity, label: string): number {
  if (position.source !== source.id || position.epoch !== source.epoch) {
    throw new Error(
      `${label} belongs to ${position.source}/${position.epoch}, expected ${source.id}/${source.epoch}`,
    );
  }
  return safeInteger(Number(position.cursor), `${label} cursor`);
}

function manifestUrl(endpoint: URL, collection: string): URL {
  return new URL(
    `/v1/collections/${encodeURIComponent(collection)}/manifest`,
    endpoint,
  );
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 ||
    status === 500 || status === 502 || status === 503 || status === 504;
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(10_000, Math.max(0, date - Date.now())) : null;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Alluvium request cancelled"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

interface OpenResponse {
  response: Response;
  close(): void;
}

async function request(
  url: URL,
  fetcher: typeof fetch,
  policy: TransportPolicy,
  signal?: AbortSignal,
): Promise<OpenResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Alluvium request timed out: ${url}`)),
      policy.requestTimeoutMs,
    );
    const abort = () => controller.abort(signal?.reason);
    const close = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const response = await fetcher(url, { signal: controller.signal });
      if (!retryableStatus(response.status) || attempt === policy.maxAttempts) {
        return { response, close };
      }
      void response.body?.cancel();
      close();
      await delay(
        retryAfter(response) ?? Math.min(5_000, 250 * 2 ** (attempt - 1)),
        signal,
      );
    } catch (error) {
      lastError = error;
      close();
      if (signal?.aborted) throw signal.reason;
      if (attempt === policy.maxAttempts) throw error;
      await delay(Math.min(5_000, 250 * 2 ** (attempt - 1)), signal);
    }
  }
  throw lastError ?? new Error(`Alluvium request failed: ${url}`);
}

async function boundedResponseBytes(
  response: Response,
  expectedBytes: number,
  url: URL,
): Promise<Uint8Array> {
  if (!response.body) throw new Error(`Alluvium object response has no body: ${url}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > expectedBytes) {
        await reader.cancel("Alluvium object exceeded its declared byte length");
        throw new Error(`Alluvium object exceeds ${expectedBytes} declared bytes: ${url}`);
      }
      chunks.push(step.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseBasePart(value: unknown, label: string): AlluviumBasePart {
  if (!object(value)) throw new TypeError(`${label} must be an object`);
  return {
    part: safeInteger(value.part, `${label}.part`),
    url: string(value.url, `${label}.url`),
    checksum: checksum(value.checksum, `${label}.checksum`),
    records: safeInteger(value.records, `${label}.records`),
    compressedBytes: positiveInteger(value.compressedBytes, `${label}.compressedBytes`),
  };
}

function parseHistoricalCoverage(value: unknown, label: string): AlluviumHistoricalCoverage {
  if (!object(value)) throw new TypeError(`${label} must be an object`);
  if (value.scope !== "configured-relays") throw new TypeError(`${label}.scope is unsupported`);
  if (value.status !== "complete" && value.status !== "incomplete" && value.status !== "unknown") {
    throw new TypeError(`${label}.status is unsupported`);
  }
  const report = value.report === null
    ? null
    : (() => {
        if (!object(value.report)) throw new TypeError(`${label}.report must be an object or null`);
        if (value.report.mediaType !== "application/gzip") {
          throw new TypeError(`${label}.report.mediaType is unsupported`);
        }
        return {
          url: string(value.report.url, `${label}.report.url`),
          checksum: checksum(value.report.checksum, `${label}.report.checksum`),
          compressedBytes: positiveInteger(
            value.report.compressedBytes,
            `${label}.report.compressedBytes`,
          ),
          mediaType: "application/gzip" as const,
        };
      })();
  const status: AlluviumHistoricalCoverage["status"] = value.status;
  const parsed = {
    scope: "configured-relays" as const,
    status,
    accountsDiscovered: safeInteger(value.accountsDiscovered, `${label}.accountsDiscovered`),
    accountsIncluded: safeInteger(value.accountsIncluded, `${label}.accountsIncluded`),
    accountsOmitted: safeInteger(value.accountsOmitted, `${label}.accountsOmitted`),
    report,
  };
  if (parsed.accountsIncluded + parsed.accountsOmitted !== parsed.accountsDiscovered) {
    throw new TypeError(`${label} account totals disagree`);
  }
  return parsed;
}

function parseTailObject(value: unknown, label: string): AlluviumTailObject {
  if (!object(value)) throw new TypeError(`${label} must be an object`);
  const run = safeInteger(value.run, `${label}.run`);
  const firstRun = value.firstRun === undefined
    ? undefined
    : safeInteger(value.firstRun, `${label}.firstRun`);
  const lastRun = value.lastRun === undefined
    ? undefined
    : safeInteger(value.lastRun, `${label}.lastRun`);
  if ((firstRun ?? run) > (lastRun ?? run) || (lastRun ?? run) !== run) {
    throw new TypeError(`${label} has an invalid run range`);
  }
  const firstTimeUs = safeInteger(value.firstTimeUs, `${label}.firstTimeUs`);
  const lastTimeUs = safeInteger(value.lastTimeUs, `${label}.lastTimeUs`);
  if (firstTimeUs > lastTimeUs) throw new TypeError(`${label} has a reversed time range`);
  return {
    run,
    ...(firstRun === undefined ? {} : { firstRun }),
    ...(lastRun === undefined ? {} : { lastRun }),
    ...(value.level === undefined
      ? {}
      : value.level === "raw" || value.level === "hour" ||
          value.level === "six-hour" || value.level === "day"
        ? { level: value.level }
        : (() => { throw new TypeError(`${label}.level is unsupported`); })()),
    part: safeInteger(value.part, `${label}.part`),
    firstTimeUs,
    lastTimeUs,
    url: string(value.url, `${label}.url`),
    checksum: checksum(value.checksum, `${label}.checksum`),
    events: safeInteger(value.events, `${label}.events`),
    compressedBytes: positiveInteger(value.compressedBytes, `${label}.compressedBytes`),
  };
}

function parseManifest(value: unknown, requested: string): AlluviumCollectionManifest {
  if (!object(value) || value.format !== "alluvium.collection" || value.version !== 1) {
    throw new TypeError(`Manifest for ${requested} is not Alluvium collection version 1`);
  }
  if (value.collection !== requested) throw new TypeError(`Manifest collection mismatch for ${requested}`);
  if (
    value.state !== "pending_capture" && value.state !== "capturing" &&
    value.state !== "backfilling" && value.state !== "active" && value.state !== "gap" &&
    value.state !== "paused" && value.state !== "error"
  ) {
    throw new TypeError(`Manifest for ${requested} has an invalid state`);
  }
  if (!object(value.source) || value.source.protocol !== "jetstream-v1") {
    throw new TypeError(`Manifest for ${requested} has an unsupported source`);
  }
  if (!object(value.semantics) ||
    !Array.isArray(value.semantics.operations) ||
    value.semantics.operations.length !== 2 ||
    value.semantics.operations[0] !== "put" || value.semantics.operations[1] !== "delete" ||
    value.semantics.accountDeletion !== false || value.semantics.repositorySync !== false ||
    value.semantics.physicalPayloadDeletion !== false
  ) {
    throw new TypeError(`Manifest for ${requested} has unsupported semantics`);
  }
  if (!object(value.coverage)) throw new TypeError(`Manifest for ${requested} has no coverage`);
  if (value.coverage.historicalBootstrap !== "current-records-from-pds") {
    throw new TypeError(`Manifest for ${requested} has an unsupported historical bootstrap`);
  }
  if (!object(value.base)) throw new Error(`Alluvium collection ${requested} has no published base`);
  if (!Array.isArray(value.base.parts) || !Array.isArray(value.tail)) {
    throw new TypeError(`Manifest for ${requested} has malformed object descriptors`);
  }
  const parts = value.base.parts.length > 0
    ? value.base.parts.map((item, index) => parseBasePart(item, `${requested}.base.parts[${index}]`))
    : [parseBasePart({
        part: 0,
        url: value.base.url,
        checksum: value.base.checksum,
        records: value.base.records,
        compressedBytes: value.base.compressedBytes,
      }, `${requested}.base`)];
  for (const [index, part] of [...parts].sort((a, b) => a.part - b.part).entries()) {
    if (part.part !== index) throw new TypeError(`Manifest for ${requested} has non-contiguous base parts`);
  }
  const records = safeInteger(value.base.records, `${requested}.base.records`);
  const compressedBytes = positiveInteger(
    value.base.compressedBytes,
    `${requested}.base.compressedBytes`,
  );
  if (parts.reduce((sum, part) => sum + part.records, 0) !== records ||
    parts.reduce((sum, part) => sum + part.compressedBytes, 0) !== compressedBytes
  ) {
    throw new TypeError(`Manifest for ${requested} has inconsistent base totals`);
  }
  const capturedThroughRun = safeInteger(
    value.coverage.capturedThroughRun,
    `${requested}.coverage.capturedThroughRun`,
  );
  const capturedThroughTimeUs = safeInteger(
    value.coverage.capturedThroughTimeUs,
    `${requested}.coverage.capturedThroughTimeUs`,
  );
  const archivedThroughTimeUs = safeInteger(
    value.source.archivedThroughTimeUs,
    `${requested}.source.archivedThroughTimeUs`,
  );
  if (capturedThroughTimeUs !== archivedThroughTimeUs) {
    throw new TypeError(`Manifest for ${requested} disagrees on its archive boundary`);
  }
  return {
    format: "alluvium.collection",
    version: 1,
    collection: requested,
    state: value.state,
    source: {
      id: string(value.source.id, `${requested}.source.id`, 128),
      protocol: "jetstream-v1",
      url: string(value.source.url, `${requested}.source.url`, 2_048),
      archivedThroughTimeUs,
    },
    semantics: {
      operations: ["put", "delete"],
      accountDeletion: false,
      repositorySync: false,
      physicalPayloadDeletion: false,
    },
    coverage: {
      captureFromRun: value.coverage.captureFromRun === null
        ? null
        : safeInteger(value.coverage.captureFromRun, `${requested}.coverage.captureFromRun`),
      captureFromTimeUs: value.coverage.captureFromTimeUs === null
        ? null
        : safeInteger(value.coverage.captureFromTimeUs, `${requested}.coverage.captureFromTimeUs`),
      capturedThroughRun,
      capturedThroughTimeUs,
      knownGaps: safeInteger(value.coverage.knownGaps, `${requested}.coverage.knownGaps`),
      historicalBootstrap: "current-records-from-pds",
    },
    base: {
      generation: positiveInteger(value.base.generation, `${requested}.base.generation`),
      throughRun: safeInteger(value.base.throughRun, `${requested}.base.throughRun`),
      throughTimeUs: safeInteger(value.base.throughTimeUs, `${requested}.base.throughTimeUs`),
      url: string(value.base.url, `${requested}.base.url`),
      checksum: checksum(value.base.checksum, `${requested}.base.checksum`),
      records,
      compressedBytes,
      seedKind:
        value.base.seedKind === "backfill" || value.base.seedKind === "fold" ||
        value.base.seedKind === "rebuild"
          ? value.base.seedKind
          : (() => { throw new TypeError(`${requested}.base.seedKind is unsupported`); })(),
      historicalCoverage: parseHistoricalCoverage(
        value.base.historicalCoverage,
        `${requested}.base.historicalCoverage`,
      ),
      parts: parts.sort((a, b) => a.part - b.part),
    },
    tail: value.tail.map((item, index) => parseTailObject(item, `${requested}.tail[${index}]`)),
  };
}

function assertManifestEligible(
  manifest: AlluviumCollectionManifest,
  expected: AlluviumSourceIdentity,
): void {
  if (manifest.state !== "active") {
    throw new Error(`Alluvium collection ${manifest.collection} is ${manifest.state}`);
  }
  if (manifest.coverage.knownGaps > 0) {
    throw new Error(`Alluvium collection ${manifest.collection} has known capture gaps`);
  }
  if (manifest.source.id !== expected.id) {
    throw new Error(
      `Alluvium collection ${manifest.collection} uses source ${manifest.source.id}, expected ${expected.id}`,
    );
  }
  const actualUrl = new URL(manifest.source.url).href.replace(/\/$/, "");
  if (actualUrl !== expected.url) {
    throw new Error(
      `Alluvium collection ${manifest.collection} uses ${actualUrl}, expected ${expected.url}`,
    );
  }
  if (manifest.base.throughRun > manifest.coverage.capturedThroughRun ||
    manifest.base.throughTimeUs > manifest.coverage.capturedThroughTimeUs
  ) {
    throw new Error(`Alluvium base for ${manifest.collection} is newer than its archive boundary`);
  }
  for (const descriptor of manifest.tail) {
    if ((descriptor.lastRun ?? descriptor.run) > manifest.coverage.capturedThroughRun ||
      descriptor.lastTimeUs > manifest.coverage.capturedThroughTimeUs
    ) {
      throw new Error(`Alluvium tail for ${manifest.collection} exceeds its archive boundary`);
    }
  }
}

function coverage(manifest: AlluviumCollectionManifest): CollectionCoverage {
  const historical = manifest.base.historicalCoverage;
  if (historical.status === "complete" && historical.accountsOmitted === 0) {
    return { state: "complete" };
  }
  return {
    state: "partial",
    reason: historical.status === "unknown"
      ? "Alluvium historical coverage is unknown"
      : "Alluvium historical coverage omitted accounts",
    unresolved: historical.accountsOmitted,
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

async function pinnedId(data: PinnedAlluviumData): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return `alluvium-${(await sha256(bytes)).slice("sha256:".length)}`;
}

function parsePinned(snapshot: PreparedSnapshot): PinnedAlluviumData {
  const value = snapshot.providerData;
  if (snapshot.provider !== "alluvium" || !object(value) ||
    value.format !== "contrail.alluvium-snapshot" || value.version !== 1 ||
    !object(value.source) || !object(value.archiveThrough) || !object(value.manifests)
  ) {
    throw new TypeError("Prepared snapshot is not a supported Alluvium descriptor");
  }
  const source = normalizeSource({
    id: string(value.source.id, "providerData.source.id", 128),
    epoch: string(value.source.epoch, "providerData.source.epoch", 128),
    url: string(value.source.url, "providerData.source.url", 2_048),
  });
  const manifests = Object.fromEntries(
    Object.entries(value.manifests).map(([collection, manifest]) => [
      collection,
      parseManifest(manifest, collection),
    ]),
  );
  const selected = Object.values(manifests);
  if (selected.length === 0 || selected.length > MAX_COLLECTIONS) {
    throw new TypeError("Prepared Alluvium snapshot has an invalid collection count");
  }
  const base = selected[0]!.base;
  const archiveRun = safeInteger(value.archiveThrough.run, "providerData.archiveThrough.run");
  const archiveTimeUs = safeInteger(
    value.archiveThrough.timeUs,
    "providerData.archiveThrough.timeUs",
  );
  for (const manifest of selected) {
    assertManifestEligible(manifest, source);
    if (manifest.base.throughRun !== base.throughRun ||
      manifest.base.throughTimeUs !== base.throughTimeUs
    ) {
      throw new Error("Prepared Alluvium snapshot bases do not share one boundary");
    }
    if (manifest.coverage.capturedThroughRun !== archiveRun ||
      manifest.coverage.capturedThroughTimeUs !== archiveTimeUs
    ) {
      throw new Error("Prepared Alluvium snapshot archive boundaries disagree");
    }
  }
  return {
    format: "contrail.alluvium-snapshot",
    version: 1,
    endpoint: string(value.endpoint, "providerData.endpoint", 2_048),
    source,
    archiveThrough: { run: archiveRun, timeUs: archiveTimeUs },
    manifests,
  };
}

function assertRequestedPinned(
  data: PinnedAlluviumData,
  collections: string[],
  endpoint: URL,
  source: AlluviumSourceIdentity,
): void {
  if (data.endpoint !== endpoint.href ||
    data.source.id !== source.id || data.source.epoch !== source.epoch || data.source.url !== source.url
  ) {
    throw new Error("Prepared Alluvium descriptor does not match this adapter");
  }
  const requested = [...new Set(collections)].sort();
  const pinned = Object.keys(data.manifests).sort();
  if (JSON.stringify(requested) !== JSON.stringify(pinned)) {
    throw new Error("Prepared Alluvium descriptor has different collections");
  }
}

function objectUrl(raw: string, endpoint: URL): URL {
  const url = new URL(raw, endpoint);
  if (url.origin !== endpoint.origin) {
    throw new Error(`Alluvium object URL leaves the provider origin: ${url}`);
  }
  if (url.protocol !== endpoint.protocol) {
    throw new Error(`Alluvium object URL changes protocol: ${url}`);
  }
  return url;
}

async function verifiedCompressedObject(
  descriptor: { url: string; checksum: string; compressedBytes: number },
  endpoint: URL,
  fetcher: typeof fetch,
  policy: TransportPolicy,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (descriptor.compressedBytes > policy.maxCompressedBytes) {
    throw new Error(
      `Alluvium object ${descriptor.url} exceeds the configured compressed-byte limit`,
    );
  }
  const url = objectUrl(descriptor.url, endpoint);
  const opened = await request(url, fetcher, policy, signal);
  try {
    const { response } = opened;
    if (!response.ok) throw new Error(`Alluvium object request failed (${response.status}): ${url}`);
    const declaredLength = response.headers.get("Content-Length");
    if (declaredLength !== null && Number(declaredLength) !== descriptor.compressedBytes) {
      void response.body?.cancel();
      throw new Error(`Alluvium object Content-Length mismatch: ${url}`);
    }
    const bytes = await boundedResponseBytes(response, descriptor.compressedBytes, url);
    if (bytes.byteLength !== descriptor.compressedBytes) {
      throw new Error(
        `Alluvium object byte length ${bytes.byteLength} != ${descriptor.compressedBytes}: ${url}`,
      );
    }
    const actual = await sha256(bytes);
    if (actual !== descriptor.checksum) {
      throw new Error(`Alluvium object checksum ${actual} != ${descriptor.checksum}: ${url}`);
    }
    return bytes;
  } finally {
    opened.close();
  }
}

async function* jsonLines(
  compressed: Uint8Array,
  maxLineCharacters: number,
): AsyncGenerator<unknown> {
  const body = new Response(compressed).body;
  if (!body) throw new Error("Could not construct an Alluvium object stream");
  const text = body
    .pipeThrough(
      new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    )
    .pipeThrough(
      new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
    );
  const reader = text.getReader();
  let buffered = "";
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buffered += step.value;
      if (buffered.length > maxLineCharacters && !buffered.includes("\n")) {
        throw new Error("Alluvium JSONL line exceeds the configured limit");
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > maxLineCharacters) {
          throw new Error("Alluvium JSONL line exceeds the configured limit");
        }
        if (line.length > 0) yield JSON.parse(line) as unknown;
      }
    }
    if (buffered.length > maxLineCharacters) {
      throw new Error("Alluvium JSONL line exceeds the configured limit");
    }
    if (buffered.length > 0) yield JSON.parse(buffered) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function baseRecord(
  value: unknown,
  collection: string,
  label: string,
): SnapshotRecord {
  if (!object(value) || value.v !== 1) throw new TypeError(`${label} is malformed`);
  const envelope = exactUri(value.uri, value.did, value.collection, value.rkey, label);
  if (envelope.collection !== collection) throw new TypeError(`${label} has the wrong collection`);
  const cid = string(value.cid, `${label}.cid`, 256);
  if (!("record" in value)) throw new TypeError(`${label}.record is missing`);
  return { ...envelope, cid, value: value.record };
}

function deltaEvent(
  value: unknown,
  manifest: AlluviumCollectionManifest,
  descriptor: AlluviumTailObject,
  source: AlluviumSourceIdentity,
  label: string,
): AlluviumDeltaEvent {
  if (!object(value) || value.v !== 1 || (value.op !== "put" && value.op !== "delete")) {
    throw new TypeError(`${label} is malformed`);
  }
  const envelope = exactUri(value.uri, value.did, value.collection, value.rkey, label);
  if (envelope.collection !== manifest.collection) throw new TypeError(`${label} has the wrong collection`);
  if (value.source !== source.id) throw new TypeError(`${label} has the wrong source`);
  const run = safeInteger(value.run, `${label}.run`);
  const firstRun = descriptor.firstRun ?? descriptor.run;
  const lastRun = descriptor.lastRun ?? descriptor.run;
  if (run < firstRun || run > lastRun) throw new TypeError(`${label} is outside its run range`);
  const timeUs = safeInteger(value.timeUs, `${label}.timeUs`);
  if (timeUs < descriptor.firstTimeUs || timeUs > descriptor.lastTimeUs) {
    throw new TypeError(`${label} is outside its time range`);
  }
  const revision = value.rev === undefined ? undefined : string(value.rev, `${label}.rev`, 256);
  if (value.op === "delete") {
    return { v: 1, run, timeUs, source: source.id, op: "delete", ...envelope, ...(revision ? { rev: revision } : {}) };
  }
  if (!("record" in value)) throw new TypeError(`${label}.record is missing`);
  return {
    v: 1,
    run,
    timeUs,
    source: source.id,
    op: "put",
    ...envelope,
    ...(revision ? { rev: revision } : {}),
    cid: string(value.cid, `${label}.cid`, 256),
    record: value.record,
  };
}

function sourceMutation(event: AlluviumDeltaEvent, source: AlluviumSourceIdentity): SourceMutation {
  const base = {
    uri: event.uri,
    did: event.did,
    collection: event.collection,
    rkey: event.rkey,
    ...(event.rev ? { revision: event.rev } : {}),
    sourceTimeUs: event.timeUs,
    position: sourcePosition(source, event.timeUs),
  };
  return event.op === "delete"
    ? { ...base, operation: "delete" }
    : { ...base, operation: "put", cid: event.cid, value: event.record };
}

async function fetchManifest(
  endpoint: URL,
  collection: string,
  fetcher: typeof fetch,
  policy: TransportPolicy,
  signal?: AbortSignal,
): Promise<AlluviumCollectionManifest> {
  const url = manifestUrl(endpoint, collection);
  const opened = await request(url, fetcher, policy, signal);
  try {
    if (!opened.response.ok) {
      throw new Error(`Alluvium manifest request failed (${opened.response.status}): ${url}`);
    }
    return parseManifest(await opened.response.json(), collection);
  } finally {
    opened.close();
  }
}

class AlluviumAdapterBase {
  protected readonly endpoint: URL;
  protected readonly source: AlluviumSourceIdentity;
  protected readonly policy: TransportPolicy;
  protected readonly fetcher: typeof fetch;

  constructor(protected readonly options: AlluviumBootstrapSourceOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint, options.allowInsecureHttp === true);
    this.source = normalizeSource(options.source);
    this.policy = transportPolicy(options.transport);
    this.fetcher = options.fetch ?? fetch;
  }
}

/** Experimental snapshot adapter for existing Alluvium collection manifests.
 * Protocol v1 lacks an atomic bundle, so all selected manifests must expose the
 * same source, base boundary, and captured-through boundary. */
export class AlluviumSnapshotSource extends AlluviumAdapterBase implements SnapshotSource {
  readonly id = "alluvium";

  async prepare(options: {
    collections: string[];
    signal?: AbortSignal;
  }): Promise<PreparedSnapshot> {
    const collections = [...new Set(options.collections)].sort();
    if (collections.length === 0 || collections.length > MAX_COLLECTIONS) {
      throw new TypeError(`Alluvium requires 1-${MAX_COLLECTIONS} exact collections`);
    }
    for (const collection of collections) {
      if (!isNsid(collection)) throw new TypeError(`Invalid Alluvium collection ${collection}`);
    }
    const manifests = Object.fromEntries(
      await Promise.all(
        collections.map(async (collection) => {
          const manifest = await fetchManifest(
            this.endpoint,
            collection,
            this.fetcher,
            this.policy,
            options.signal,
          );
          assertManifestEligible(manifest, this.source);
          return [collection, manifest] as const;
        }),
      ),
    );
    const selected = Object.values(manifests);
    const base = selected[0]!.base;
    const archive = selected[0]!.coverage;
    for (const manifest of selected.slice(1)) {
      if (manifest.base.throughRun !== base.throughRun ||
        manifest.base.throughTimeUs !== base.throughTimeUs
      ) {
        throw new Error(
          "Alluvium protocol v1 adapter requires selected bases at one shared boundary",
        );
      }
      if (manifest.coverage.capturedThroughRun !== archive.capturedThroughRun ||
        manifest.coverage.capturedThroughTimeUs !== archive.capturedThroughTimeUs
      ) {
        throw new Error(
          "Alluvium manifests changed during preparation; retry to pin one shared boundary",
        );
      }
    }
    const objectCount = selected.reduce(
      (total, manifest) => total + manifest.base.parts.length + manifest.tail.length,
      0,
    );
    if (objectCount > MAX_OBJECTS) throw new Error("Alluvium descriptor contains too many objects");
    const providerData: PinnedAlluviumData = {
      format: "contrail.alluvium-snapshot",
      version: 1,
      endpoint: this.endpoint.href,
      source: this.source,
      archiveThrough: {
        run: archive.capturedThroughRun,
        timeUs: archive.capturedThroughTimeUs,
      },
      manifests,
    };
    return {
      id: await pinnedId(providerData),
      provider: this.id,
      consistency: "point-in-time",
      collections: Object.fromEntries(
        selected.map((manifest) => [manifest.collection, coverage(manifest)]),
      ),
      semantics,
      through: sourcePosition(this.source, base.throughTimeUs),
      providerData,
    };
  }

  async *read(options: {
    snapshot: PreparedSnapshot;
    progress?: SnapshotProgress[];
    signal?: AbortSignal;
  }): AsyncIterable<SnapshotBatch> {
    const data = parsePinned(options.snapshot);
    const collections = Object.keys(data.manifests).sort();
    assertRequestedPinned(data, collections, this.endpoint, this.source);
    const progress = new Map((options.progress ?? []).map((item) => [item.partition, item]));
    const partitions = collections.flatMap((collection) =>
      data.manifests[collection]!.base.parts.map((part) => ({ collection, part })),
    );
    let emittedDone = false;
    for (const [partitionIndex, item] of partitions.entries()) {
      if (options.signal?.aborted) throw options.signal.reason;
      const manifest = data.manifests[item.collection]!;
      const partition = `${options.snapshot.id}/${item.collection}/base/${manifest.base.generation}/part/${item.part.part}`;
      const prior = progress.get(partition);
      if (prior?.complete) continue;
      const resumeLine = prior?.cursor === null || prior?.cursor === undefined
        ? 0
        : safeInteger(Number(prior.cursor), `Snapshot progress for ${partition}`);
      const bytes = await verifiedCompressedObject(
        item.part,
        this.endpoint,
        this.fetcher,
        this.policy,
        options.signal,
      );
      let lines = 0;
      let records: SnapshotRecord[] = [];
      for await (const raw of jsonLines(bytes, this.policy.maxLineCharacters)) {
        const record = baseRecord(raw, item.collection, `${partition} line ${lines + 1}`);
        lines++;
        if (lines <= resumeLine) continue;
        records.push(record);
        if (records.length >= this.policy.batchSize) {
          const batchProgress = { partition, cursor: String(lines), complete: false };
          yield {
            records,
            sourceTimeUs: manifest.base.throughTimeUs,
            progress: batchProgress,
            done: false,
          };
          progress.set(partition, batchProgress);
          records = [];
        }
      }
      if (lines !== item.part.records) {
        throw new Error(`${partition} record count ${lines} != ${item.part.records}`);
      }
      if (resumeLine > lines) throw new Error(`Snapshot progress exceeds ${partition}`);
      const finalPartition = partitionIndex === partitions.length - 1;
      const finalProgress = { partition, cursor: null, complete: true };
      yield {
        records,
        sourceTimeUs: manifest.base.throughTimeUs,
        progress: finalProgress,
        done: finalPartition,
      };
      progress.set(partition, finalProgress);
      emittedDone ||= finalPartition;
    }
    if (!emittedDone && partitions.every((item) => {
      const manifest = data.manifests[item.collection]!;
      const key = `${options.snapshot.id}/${item.collection}/base/${manifest.base.generation}/part/${item.part.part}`;
      return progress.get(key)?.complete;
    })) {
      yield {
        records: [],
        sourceTimeUs: Math.max(
          ...Object.values(data.manifests).map((manifest) => manifest.base.throughTimeUs),
        ),
        progress: { partition: `${options.snapshot.id}/snapshot`, cursor: null, complete: true },
        done: true,
      };
    }
  }
}

/** Experimental Alluvium archive replay ending at the exact cron cursor. */
export class AlluviumChangeSource extends AlluviumAdapterBase implements ChangeSource {
  readonly id = "alluvium";
  readonly semantics = semantics;
  private readonly direct: JetstreamChangeSource;

  constructor(config: ContrailConfig, options: AlluviumBootstrapSourceOptions) {
    super(options);
    this.direct = new JetstreamChangeSource(
      { ...config, jetstreams: [this.source.url] },
      {
        ...options.jetstream,
        sourceId: this.source.id,
        epoch: this.source.epoch,
      },
    );
  }

  async mark(options: {
    collections: string[];
    snapshot?: PreparedSnapshot;
    signal?: AbortSignal;
  }): Promise<SourcePosition> {
    // The preliminary capture mark proves the configured direct source before
    // provider preparation. Once the manifest is pinned, offline bootstrap
    // deliberately stops at Alluvium's archived boundary; ordinary cron ingest
    // owns everything after it.
    if (!options.snapshot) return this.direct.mark(options);
    const data = parsePinned(options.snapshot);
    assertRequestedPinned(data, options.collections, this.endpoint, this.source);
    return sourcePosition(this.source, data.archiveThrough.timeUs);
  }

  async *read(options: {
    collections: string[];
    snapshot?: PreparedSnapshot;
    after: SourcePosition;
    through: SourcePosition;
    signal?: AbortSignal;
  }): AsyncIterable<MutationBatch> {
    if (!options.snapshot) {
      throw new TypeError("Alluvium change replay requires its prepared snapshot");
    }
    const data = parsePinned(options.snapshot);
    assertRequestedPinned(data, options.collections, this.endpoint, this.source);
    const after = cursorNumber(options.after, this.source, "Alluvium replay start");
    const through = cursorNumber(options.through, this.source, "Alluvium replay target");
    const base = cursorNumber(
      options.snapshot.through ?? sourcePosition(this.source, 0),
      this.source,
      "Alluvium snapshot boundary",
    );
    const pinnedBase = Object.values(data.manifests)[0]!.base.throughTimeUs;
    if (base !== pinnedBase) {
      throw new Error("Prepared Alluvium position disagrees with its pinned base");
    }
    const archiveThrough = data.archiveThrough.timeUs;
    if (after < base) throw new Error("Alluvium replay starts before its pinned base");
    if (through < after) throw new Error("Alluvium replay target precedes its start");
    if (through !== archiveThrough) {
      throw new Error("Alluvium bootstrap target must equal its pinned archive boundary");
    }

    if (after < archiveThrough) {
      // Version-1 manifests expose delivery-optimized per-collection rollups,
      // not global source steps. Collect their bounded relevant tail and restore
      // cross-collection Jetstream order before projecting. A future bundle
      // protocol can stream globally ordered steps without this compatibility
      // buffer.
      const mutations: SourceMutation[] = [];
      for (const collection of [...options.collections].sort()) {
        const manifest = data.manifests[collection]!;
        const descriptors = [...manifest.tail]
          .filter((descriptor) => (descriptor.lastRun ?? descriptor.run) > manifest.base.throughRun)
          .sort((left, right) =>
            (left.firstRun ?? left.run) - (right.firstRun ?? right.run) ||
            (left.lastRun ?? left.run) - (right.lastRun ?? right.run) ||
            left.part - right.part,
          );
        let priorRange = "";
        let expectedPart = 0;
        for (const descriptor of descriptors) {
          if (options.signal?.aborted) throw options.signal.reason;
          const range = `${descriptor.firstRun ?? descriptor.run}:${descriptor.lastRun ?? descriptor.run}`;
          if (range !== priorRange) {
            priorRange = range;
            expectedPart = 0;
          }
          if (descriptor.part !== expectedPart++) {
            throw new Error(`Alluvium tail for ${collection} has non-contiguous parts in ${range}`);
          }
          const bytes = await verifiedCompressedObject(
            descriptor,
            this.endpoint,
            this.fetcher,
            this.policy,
            options.signal,
          );
          let events = 0;
          for await (const raw of jsonLines(bytes, this.policy.maxLineCharacters)) {
            const event = deltaEvent(
              raw,
              manifest,
              descriptor,
              this.source,
              `${collection} tail ${range}/${descriptor.part} line ${events + 1}`,
            );
            events++;
            if (event.run <= manifest.base.throughRun ||
              event.timeUs <= after || event.timeUs > archiveThrough
            ) {
              continue;
            }
            mutations.push(sourceMutation(event, this.source));
            if (mutations.length > this.policy.maxArchiveMutations) {
              throw new Error(
                `Alluvium archive exceeds ${this.policy.maxArchiveMutations} mutations; ` +
                  "a versioned ordered bootstrap bundle is required",
              );
            }
          }
          if (events !== descriptor.events) {
            throw new Error(
              `Alluvium tail ${collection} ${range}/${descriptor.part} event count ${events} != ${descriptor.events}`,
            );
          }
        }
      }
      mutations.sort((left, right) =>
        left.sourceTimeUs - right.sourceTimeUs ||
        left.uri.localeCompare(right.uri) ||
        left.operation.localeCompare(right.operation),
      );
      for (let index = 0; index < mutations.length;) {
        let end = Math.min(mutations.length, index + this.policy.batchSize);
        // Never split equal source timestamps: a committed numeric checkpoint
        // must not cause an uncommitted sibling with the same time_us to skip on
        // resume.
        while (end < mutations.length &&
          mutations[end]!.sourceTimeUs === mutations[end - 1]!.sourceTimeUs
        ) {
          end++;
        }
        const batch = mutations.slice(index, end);
        yield {
          mutations: batch,
          checkpoint: sourcePosition(this.source, batch.at(-1)!.sourceTimeUs),
          caughtUp: false,
        };
        index = end;
      }
      yield {
        mutations: [],
        checkpoint: sourcePosition(this.source, archiveThrough),
        caughtUp: true,
      };
    }
  }
}

/** Create a paired experimental Alluvium snapshot/archive source. */
export function createAlluviumBootstrapSources(
  config: ContrailConfig,
  options: AlluviumBootstrapSourceOptions,
): AlluviumBootstrapSources {
  return {
    snapshotSource: new AlluviumSnapshotSource(options),
    changeSource: new AlluviumChangeSource(config, options),
  };
}
