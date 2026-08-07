import type {} from "@atcute/atproto";
import type { Client } from "@atcute/client";
import { type Did, type Nsid } from "@atcute/lexicons";
import {
  isDid,
  isNsid,
  parseCanonicalResourceUri,
} from "@atcute/lexicons/syntax";
import type { ContrailConfig, Database } from "./types";
import {
  DEFAULT_RELAYS,
  getCollectionNsids,
  getDiscoverableNsids,
} from "./types";
import { discoverDIDs } from "./backfill";
import { createStreamingHostScheduler, drainQueue } from "./scheduling";
import { createPdsClient, getPDS } from "./client";
import type {
  CollectionCoverage,
  PreparedSnapshot,
  SnapshotBatch,
  SnapshotProgress,
  SnapshotSource,
} from "./sources";

const PAGE_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RESOLUTION_CONCURRENCY = 100;
const DEFAULT_PDS_CONCURRENCY = 20;
const DEFAULT_DIDS_PER_PDS = 3;

export interface PdsSnapshotSourceOptions {
  /** Concurrent DID-to-PDS resolutions. Default: 100. */
  concurrency?: number;
  /** PDS hosts allowed to fetch concurrently. Default: 20. */
  pdsConcurrency?: number;
  /** Repositories allowed to fetch concurrently from one PDS. Default: 3. */
  didsPerPds?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

/** A PDS snapshot stays resumable but not ready while any partition fails. */
export class PdsSnapshotIncompleteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdsSnapshotIncompleteError";
  }
}

function incomplete(label: string, error: unknown): PdsSnapshotIncompleteError {
  return error instanceof PdsSnapshotIncompleteError
    ? error
    : new PdsSnapshotIncompleteError(`${label}: ${String(error)}`, {
        cause: error,
      });
}

interface BackfillPartition {
  did: string;
  collection: string;
}

interface PartitionWork extends BackfillPartition {
  cursor: string | undefined;
  complete: boolean;
}

interface QueuedBatch {
  batch: SnapshotBatch;
  acknowledge(): void;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly readers: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly writers: Array<{
    item: T;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown = null;

  constructor(private readonly capacity: number) {}

  push(item: T): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("Snapshot queue is closed"));
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ value: item, done: false });
      return Promise.resolve();
    }
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.writers.push({ item, resolve, reject });
    });
  }

  close(): void {
    if (this.closed || this.failure !== null) return;
    this.closed = true;
    while (this.readers.length > 0) {
      this.readers.shift()!.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.failure !== null || this.closed) return;
    this.failure = error;
    while (this.readers.length > 0) this.readers.shift()!.reject(error);
    while (this.writers.length > 0) this.writers.shift()!.reject(error);
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      const writer = this.writers.shift();
      if (writer) {
        this.items.push(writer.item);
        writer.resolve();
      }
      return Promise.resolve({ value: item, done: false });
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.readers.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

function partitionKey(did: string, collection: string): string {
  return JSON.stringify([did, collection]);
}

function snapshotRecord(
  item: { uri: string; cid: string; value: unknown },
  expected: BackfillPartition,
) {
  let parsed: ReturnType<typeof parseCanonicalResourceUri>;
  try {
    parsed = parseCanonicalResourceUri(item.uri);
  } catch {
    throw new PdsSnapshotIncompleteError(
      `PDS returned an invalid record URI for ${expected.did}/${expected.collection}`,
    );
  }
  if (parsed.repo !== expected.did || parsed.collection !== expected.collection) {
    throw new PdsSnapshotIncompleteError(
      `PDS returned a record outside ${expected.did}/${expected.collection}`,
    );
  }
  return {
    uri: item.uri,
    did: parsed.repo,
    collection: parsed.collection,
    rkey: parsed.rkey,
    cid: item.cid,
    value: item.value,
  };
}

function progressMap(
  progress: SnapshotProgress[] | undefined,
): Map<string, SnapshotProgress> {
  return new Map((progress ?? []).map((item) => [item.partition, item]));
}

function configuredCollectionSet(config: ContrailConfig): Set<string> {
  return new Set(getCollectionNsids(config));
}

function discoverableCollections(
  config: ContrailConfig,
  requested: ReadonlySet<string>,
): string[] {
  return getDiscoverableNsids(config).filter((collection) =>
    requested.has(collection),
  );
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

async function pendingDiscoveryCount(
  db: Database,
  collections: string[],
): Promise<number> {
  if (collections.length === 0) return 0;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM discovery
       WHERE collection IN (${placeholders(collections)}) AND completed = 0`,
    )
    .bind(...collections)
    .first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

async function dueDiscoveryCount(
  db: Database,
  collections: string[],
): Promise<number> {
  if (collections.length === 0) return 0;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM discovery
       WHERE collection IN (${placeholders(collections)}) AND completed = 0
         AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
    )
    .bind(...collections, Date.now())
    .first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Snapshot cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function withRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    label: string;
    parent?: AbortSignal;
    timeoutMs: number;
    maxRetries: number;
  },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (options.parent?.aborted) throw options.parent.reason;
    const controller = new AbortController();
    const abort = () => controller.abort(options.parent?.reason);
    options.parent?.addEventListener("abort", abort, { once: true });
    if (options.parent?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new Error(`Timeout: ${options.label}`)),
      options.timeoutMs,
    );
    try {
      return await operation(controller.signal);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
      options.parent?.removeEventListener("abort", abort);
    }
    if (attempt < options.maxRetries) {
      await delay(Math.min(1000 * 2 ** attempt, 10_000), options.parent);
    }
  }
  throw lastError;
}

/** Current-state snapshot provider backed by relay discovery and PDS listRecords. */
export class PdsSnapshotSource implements SnapshotSource {
  readonly id = "pds";

  constructor(
    private readonly db: Database,
    private readonly config: ContrailConfig,
    private readonly options: PdsSnapshotSourceOptions = {},
  ) {}

  async prepare(options: {
    collections: string[];
    signal?: AbortSignal;
  }): Promise<PreparedSnapshot> {
    const configured = configuredCollectionSet(this.config);
    for (const collection of options.collections) {
      if (!configured.has(collection)) {
        throw new Error(`PDS snapshot requested unknown collection ${collection}`);
      }
      if (!isNsid(collection)) {
        throw new Error(`PDS snapshot requested invalid collection ${collection}`);
      }
    }

    const requested = new Set(options.collections);
    const discoverable = discoverableCollections(this.config, requested);
    const relays = this.config.relays ?? DEFAULT_RELAYS;
    if (discoverable.length > 0 && relays.length === 0) {
      throw new PdsSnapshotIncompleteError(
        "PDS snapshot cannot discover repositories without a relay",
      );
    }

    // The bootstrap coordinator persisted its change-source mark before calling
    // prepare. Discovery may therefore resume repeatedly without opening a gap.
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason;
      try {
        await discoverDIDs(this.db, this.config, Infinity, {
          captureReplayBoundary: false,
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        throw incomplete("Relay discovery failed", error);
      }
      const pending = await pendingDiscoveryCount(this.db, discoverable);
      if (pending === 0) break;
      if ((await dueDiscoveryCount(this.db, discoverable)) === 0) {
        throw new PdsSnapshotIncompleteError(
          `${pending} relay discovery partition(s) remain retryable`,
        );
      }
    }

    const coverage = Object.fromEntries(
      options.collections.map((collection) => [
        collection,
        { state: "complete" } satisfies CollectionCoverage,
      ]),
    );
    return {
      id: `pds-${Date.now().toString(36)}-${crypto.randomUUID()}`,
      provider: this.id,
      consistency: "sampled-current-state",
      collections: coverage,
      semantics: {
        ordinaryRecords: true,
        ordinaryDeletes: false,
        accountLifecycle: false,
        repositoryReplacement: false,
        verifiedCommits: false,
        explicitHead: false,
      },
    };
  }

  async *read(options: {
    snapshot: PreparedSnapshot;
    progress?: SnapshotProgress[];
    signal?: AbortSignal;
  }): AsyncIterable<SnapshotBatch> {
    if (options.snapshot.provider !== this.id) {
      throw new Error(
        `PDS source cannot read snapshot from ${options.snapshot.provider}`,
      );
    }
    const collections = Object.keys(options.snapshot.collections);
    const rows = await this.partitions(collections);
    const progress = progressMap(options.progress);
    const byDid = new Map<string, PartitionWork[]>();
    for (const row of rows) {
      const prior = progress.get(partitionKey(row.did, row.collection));
      if (prior?.complete) continue;
      const work = byDid.get(row.did) ?? [];
      work.push({
        ...row,
        cursor: prior?.cursor ?? undefined,
        complete: false,
      });
      byDid.set(row.did, work);
    }

    const pdsConcurrency = positiveInteger(
      this.options.pdsConcurrency,
      DEFAULT_PDS_CONCURRENCY,
    );
    const didsPerPds = positiveInteger(
      this.options.didsPerPds,
      DEFAULT_DIDS_PER_PDS,
    );
    const resolutionConcurrency = positiveInteger(
      this.options.concurrency,
      DEFAULT_RESOLUTION_CONCURRENCY,
    );
    const requestTimeoutMs = positiveInteger(
      this.options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const maxRetries =
      typeof this.options.maxRetries === "number" &&
      Number.isFinite(this.options.maxRetries) &&
      this.options.maxRetries >= 0
        ? Math.floor(this.options.maxRetries)
        : 3;
    const queue = new BoundedAsyncQueue<QueuedBatch>(
      Math.max(2, pdsConcurrency * didsPerPds * 2),
    );
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const producer = (async () => {
      const clients = new Map<string, Client>();
      const scheduler = createStreamingHostScheduler(
        pdsConcurrency,
        didsPerPds,
        async (pds, did) => {
          if (controller.signal.aborted) throw controller.signal.reason;
          let client = clients.get(pds);
          if (!client) {
            client = createPdsClient(pds);
            clients.set(pds, client);
          }
          const batches: SnapshotBatch[] = [];
          const works = byDid.get(did)!;
          for (const work of works) {
            if (work.complete) continue;
            let response;
            try {
              response = await withRetry(
                (signal) =>
                  client!.get("com.atproto.repo.listRecords", {
                    params: {
                      repo: did as Did,
                      collection: work.collection as Nsid,
                      limit: PAGE_SIZE,
                      cursor: work.cursor,
                    },
                    signal,
                  }),
                {
                  label: `listRecords(${did}/${work.collection})`,
                  parent: controller.signal,
                  timeoutMs: requestTimeoutMs,
                  maxRetries,
                },
              );
            } catch (error) {
              if (controller.signal.aborted) throw controller.signal.reason;
              throw incomplete(
                `listRecords failed for ${did}/${work.collection}`,
                error,
              );
            }
            if (!response.ok) {
              const detail = response.data.message
                ? `${response.data.error}: ${response.data.message}`
                : response.data.error;
              throw new PdsSnapshotIncompleteError(
                `listRecords failed for ${did}/${work.collection}: ` +
                  `${response.status} ${detail}`,
              );
            }

            const nextCursor = response.data.cursor ?? null;
            if (nextCursor !== null && nextCursor === work.cursor) {
              throw new PdsSnapshotIncompleteError(
                `listRecords repeated cursor for ${did}/${work.collection}`,
              );
            }
            work.cursor = nextCursor ?? undefined;
            work.complete = nextCursor === null;
            batches.push({
              records: response.data.records.map((record) =>
                snapshotRecord(record, work),
              ),
              sourceTimeUs: Date.now() * 1000,
              progress: {
                partition: partitionKey(did, work.collection),
                cursor: nextCursor,
                complete: work.complete,
              },
              done: false,
            });
          }
          return {
            batches,
            complete: works.every((work) => work.complete),
          };
        },
        async (result) => {
          for (const batch of result.batches) {
            let acknowledge!: () => void;
            let reject!: (error: unknown) => void;
            const acknowledged = new Promise<void>((resolve, rejectPromise) => {
              acknowledge = resolve;
              reject = rejectPromise;
            });
            const cancel = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", cancel, { once: true });
            await queue.push({ batch, acknowledge });
            try {
              await acknowledged;
            } finally {
              controller.signal.removeEventListener("abort", cancel);
            }
          }
          return !result.complete;
        },
      );

      await drainQueue(
        [...byDid.keys()],
        resolutionConcurrency,
        async (did) => {
          let pds: string | null | undefined;
          try {
            pds = await withRetry(
              (signal) => getPDS(did as Did, this.db, this.config, signal),
              {
                label: `getPDS(${did})`,
                parent: controller.signal,
                timeoutMs: requestTimeoutMs,
                maxRetries: Math.min(maxRetries, 1),
              },
            );
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            throw incomplete(`PDS resolution failed for ${did}`, error);
          }
          if (!pds) {
            throw new PdsSnapshotIncompleteError(`PDS not found for ${did}`);
          }
          return { did, pds: pds.replace(/\/+$/, "") };
        },
        ({ did, pds }) => scheduler.add(pds, did),
      );
      await scheduler.finish();
      await queue.push({
        batch: {
          records: [],
          sourceTimeUs: Date.now() * 1000,
          progress: { partition: "snapshot", cursor: null, complete: true },
          done: true,
        },
        acknowledge() {},
      });
      queue.close();
    })().catch((error) => queue.fail(error));

    try {
      for await (const queued of queue) {
        if (controller.signal.aborted) throw controller.signal.reason;
        yield queued.batch;
        queued.acknowledge();
      }
      await producer;
    } finally {
      controller.abort(new Error("PDS snapshot reader closed"));
      queue.fail(controller.signal.reason);
      options.signal?.removeEventListener("abort", abort);
      await producer;
    }
  }

  private async partitions(collections: string[]): Promise<BackfillPartition[]> {
    if (collections.length === 0) return [];
    const rows = await this.db
      .prepare(
        `SELECT did, collection FROM backfills
         WHERE collection IN (${placeholders(collections)})
         ORDER BY did, collection`,
      )
      .bind(...collections)
      .all<BackfillPartition>();
    const valid: BackfillPartition[] = [];
    for (const row of rows.results ?? []) {
      if (!isDid(row.did) || !isNsid(row.collection)) {
        throw new PdsSnapshotIncompleteError(
          `Invalid discovered PDS partition ${row.did}/${row.collection}`,
        );
      }
      valid.push(row);
    }
    return valid;
  }
}
