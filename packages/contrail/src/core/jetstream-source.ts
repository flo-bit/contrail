import {
  JetstreamSubscription,
  type JetstreamEvent,
  type JetstreamSubscriptionOptions,
} from "@atcute/jetstream";
import type { ChangeSource, MutationBatch, SourceMutation, SourcePosition } from "./sources";
import type { ContrailConfig } from "./types";
import { DEFAULT_JETSTREAMS, jetstreamUrlOption } from "./types";

const BATCH_EVENTS = 50;
const DEFAULT_MARK_TIMEOUT_MS = 15_000;
const DEFAULT_READ_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_REPLAY_OVERLAP_US = 10_000_000;

interface JetstreamReader extends AsyncIterable<JetstreamEvent> {}

type SubscriptionFactory = (
  options: JetstreamSubscriptionOptions,
) => JetstreamReader;

export interface JetstreamChangeSourceOptions {
  /** Operator-owned continuity epoch for this endpoint set. Change it whenever
   * history continuity or cursor meaning may have changed. */
  epoch: string;
  /** Additional busy collections used only as ordered watermarks. Their records
   * are never projected unless they were also requested by the bootstrap. */
  watermarkCollections?: string[];
  /** Guaranteed source retention. Replay older than this fails before connect. */
  retentionUs: number;
  markTimeoutMs?: number;
  readIdleTimeoutMs?: number;
  replayOverlapUs?: number;
  /** @internal Deterministic transport seam for conformance tests. */
  subscriptionFactory?: SubscriptionFactory;
}

export class SourceHistoryExpiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceHistoryExpiredError";
  }
}

export class SourceCatchupIncompleteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceCatchupIncompleteError";
  }
}

function cursorNumber(position: SourcePosition, label: string): number {
  const value = Number(position.cursor);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a valid Jetstream cursor`);
  }
  return value;
}

function closeIterator(iterator: AsyncIterator<JetstreamEvent>): void {
  Promise.resolve(iterator.return?.()).catch(() => {});
}

async function nextWithTimeout(
  iterator: AsyncIterator<JetstreamEvent>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IteratorResult<JetstreamEvent>> {
  if (signal?.aborted) throw signal.reason;
  const next = iterator.next();
  next.catch(() => {});
  return await new Promise<IteratorResult<JetstreamEvent>>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const succeed = (value: IteratorResult<JetstreamEvent>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(signal?.reason ?? new Error("Replay cancelled"));
    const timer = setTimeout(
      () =>
        fail(new SourceCatchupIncompleteError("Jetstream watermark timed out")),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    next.then(succeed, fail);
  });
}

function wantedCollections(
  requested: string[],
  watermarks: string[] | undefined,
): string[] {
  return [...new Set([...requested, ...(watermarks ?? [])])].sort();
}

function position(source: string, epoch: string, cursor: number): SourcePosition {
  return { source, epoch, cursor: String(cursor) };
}

function mutationFromEvent(
  event: Extract<JetstreamEvent, { kind: "commit" }>,
  source: string,
  epoch: string,
): SourceMutation {
  const commit = event.commit;
  const base = {
    uri: `at://${event.did}/${commit.collection}/${commit.rkey}`,
    did: event.did,
    collection: commit.collection,
    rkey: commit.rkey,
    revision: commit.rev,
    sourceTimeUs: event.time_us,
    position: position(source, epoch, event.time_us),
  };
  return commit.operation === "delete"
    ? { ...base, operation: "delete" }
    : {
        ...base,
        operation: "put",
        cid: commit.cid,
        value: commit.record,
      };
}

/** Ordered replay adapter for Jetstream's microsecond cursor protocol.
 *
 * Jetstream has no separate head endpoint. Marks therefore wait for a real
 * event from the same filtered stream, and replay waits for an event strictly
 * beyond that mark. Quiet application collections can add a busy watermark
 * collection without projecting its records. This avoids claiming catch-up
 * from wall clock or a short idle period. */
export class JetstreamChangeSource implements ChangeSource {
  readonly id = "jetstream";
  readonly semantics = {
    ordinaryRecords: true,
    ordinaryDeletes: true,
    accountLifecycle: false,
    repositoryReplacement: false,
    verifiedCommits: false,
    explicitHead: true,
  } as const;
  private readonly createSubscription: SubscriptionFactory;

  constructor(
    private readonly config: ContrailConfig,
    private readonly options: JetstreamChangeSourceOptions,
  ) {
    if (!options.epoch) throw new TypeError("Jetstream source epoch is required");
    if (!Number.isSafeInteger(options.retentionUs) || options.retentionUs <= 0) {
      throw new TypeError("Jetstream retentionUs must be a positive safe integer");
    }
    this.createSubscription =
      options.subscriptionFactory ??
      ((subscriptionOptions) => new JetstreamSubscription(subscriptionOptions));
  }

  async mark(options: {
    collections: string[];
    signal?: AbortSignal;
  }): Promise<SourcePosition> {
    const subscription = this.createSubscription({
      url: jetstreamUrlOption(
        this.config.jetstreams ?? DEFAULT_JETSTREAMS,
      ),
      wantedCollections: wantedCollections(
        options.collections,
        this.options.watermarkCollections,
      ),
    });
    const iterator = subscription[Symbol.asyncIterator]();
    try {
      const step = await nextWithTimeout(
        iterator,
        this.options.markTimeoutMs ?? DEFAULT_MARK_TIMEOUT_MS,
        options.signal,
      );
      if (step.done) {
        throw new SourceCatchupIncompleteError(
          "Jetstream ended before producing a capture watermark",
        );
      }
      return position(this.id, this.options.epoch, step.value.time_us);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof SourceCatchupIncompleteError) throw error;
      throw new SourceCatchupIncompleteError(
        `Jetstream could not produce a capture watermark: ${String(error)}`,
        { cause: error },
      );
    } finally {
      closeIterator(iterator);
    }
  }

  async *read(options: {
    collections: string[];
    after: SourcePosition;
    through: SourcePosition;
    signal?: AbortSignal;
  }): AsyncIterable<MutationBatch> {
    this.assertPosition(options.after, "Replay start");
    this.assertPosition(options.through, "Replay target");
    const after = cursorNumber(options.after, "Replay start");
    const through = cursorNumber(options.through, "Replay target");
    if (through < after) {
      throw new Error("Jetstream replay target precedes its start");
    }
    if (Date.now() * 1000 - after > this.options.retentionUs) {
      throw new SourceHistoryExpiredError(
        "Jetstream replay start is older than the configured retention guarantee",
      );
    }
    if (through === after) return;

    const requested = new Set(options.collections);
    const overlap = Math.max(
      0,
      Math.floor(this.options.replayOverlapUs ?? DEFAULT_REPLAY_OVERLAP_US),
    );
    const subscription = this.createSubscription({
      url: jetstreamUrlOption(
        this.config.jetstreams ?? DEFAULT_JETSTREAMS,
      ),
      wantedCollections: wantedCollections(
        options.collections,
        this.options.watermarkCollections,
      ),
      cursor: Math.max(0, after - overlap),
    });
    const iterator = subscription[Symbol.asyncIterator]();
    let mutations: SourceMutation[] = [];
    let observed = 0;
    let checkpoint = after;

    try {
      for (;;) {
        const step = await nextWithTimeout(
          iterator,
          this.options.readIdleTimeoutMs ?? DEFAULT_READ_IDLE_TIMEOUT_MS,
          options.signal,
        );
        if (step.done) {
          throw new SourceCatchupIncompleteError(
            "Jetstream ended before the catch-up watermark",
          );
        }
        const event = step.value;
        if (event.time_us <= after) continue;
        if (event.time_us < checkpoint) {
          throw new SourceCatchupIncompleteError(
            "Jetstream replay moved backwards within one continuity epoch",
          );
        }
        if (event.time_us > through) {
          yield {
            mutations,
            checkpoint: options.through,
            caughtUp: true,
          };
          return;
        }

        checkpoint = event.time_us;
        observed++;
        if (
          event.kind === "commit" &&
          requested.has(event.commit.collection)
        ) {
          mutations.push(mutationFromEvent(event, this.id, this.options.epoch));
        }
        if (observed >= BATCH_EVENTS) {
          yield {
            mutations,
            checkpoint: position(this.id, this.options.epoch, checkpoint),
            caughtUp: false,
          };
          mutations = [];
          observed = 0;
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (
        error instanceof SourceCatchupIncompleteError ||
        error instanceof SourceHistoryExpiredError
      ) {
        throw error;
      }
      throw new SourceCatchupIncompleteError(
        `Jetstream replay failed before the target watermark: ${String(error)}`,
        { cause: error },
      );
    } finally {
      closeIterator(iterator);
    }
  }

  private assertPosition(value: SourcePosition, label: string): void {
    if (value.source !== this.id || value.epoch !== this.options.epoch) {
      throw new Error(
        `${label} belongs to ${value.source}/${value.epoch}, expected ` +
          `${this.id}/${this.options.epoch}`,
      );
    }
  }
}
