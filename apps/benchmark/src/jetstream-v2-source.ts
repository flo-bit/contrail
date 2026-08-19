import {
  Jetstream,
  type CollectionFilter,
  type Kind,
} from "@bsky/jetstream";
import {
  MeteredFetch,
  type SourceBatch,
  type SourceEvent,
  type SourceLoader,
  type SourceLoadOptions,
  type TransportMetrics,
} from "./source-loader.ts";

export const DEFAULT_JETSTREAM_V2_SERVICE =
  "https://jetstream.us-east.bsky.network";

export interface JetstreamV2SourceOptions {
  service?: string;
  apiKey: string;
  collection: string;
  afterSeq?: number;
  beforeSeq?: number;
  blockConcurrency?: number;
  snapshotBufferBytes?: number;
  /** Include account-deletion and repository-sync markers so a folding sink can
   * remove stale records. Disable only for an intentionally commits-only run. */
  lifecycle?: boolean;
  fetchImpl?: typeof fetch;
}

/** Small benchmark-facing adapter around the official Jetstream v2 SDK.
 * It exposes source batches without imposing a database or projection sink. */
export class JetstreamV2Source implements SourceLoader {
  readonly id = "jetstream-v2";
  readonly service: string;
  private readonly meter: MeteredFetch;
  private readonly client: Jetstream;
  private readonly options: JetstreamV2SourceOptions;

  constructor(options: JetstreamV2SourceOptions) {
    this.options = options;
    this.service = options.service ?? DEFAULT_JETSTREAM_V2_SERVICE;
    this.meter = new MeteredFetch(options.fetchImpl);
    this.client = new Jetstream({
      service: this.service,
      apiKey: options.apiKey,
      fetchImpl: this.meter.fetch,
      ...(options.blockConcurrency === undefined
        ? {}
        : { blockConcurrency: options.blockConcurrency }),
      ...(options.snapshotBufferBytes === undefined
        ? {}
        : { snapshotBufferBytes: options.snapshotBufferBytes }),
    });
  }

  async *load(
    options: SourceLoadOptions = {},
  ): AsyncIterable<SourceBatch> {
    const kinds: Kind[] = this.options.lifecycle === false
      ? ["commit"]
      : ["commit", "account", "sync"];
    for await (const batch of this.client.snapshotRawBatches({
      collections: [this.options.collection as CollectionFilter],
      kinds,
      afterSeq: this.options.afterSeq ?? 0,
      ...(this.options.beforeSeq === undefined
        ? {}
        : { beforeSeq: this.options.beforeSeq }),
      signal: options.signal,
    })) {
      const events: SourceEvent[] = batch.events.map((event) => {
        if (event.kind === "account") {
          return {
            kind: "account",
            did: event.did,
            active: event.account.active,
            ...(event.account.status === undefined
              ? {}
              : { status: event.account.status }),
          };
        }
        if (event.kind === "sync") {
          return { kind: "sync", did: event.did };
        }
        if (event.kind !== "commit") {
          throw new Error(`Unexpected Jetstream event kind: ${event.kind}`);
        }
        const commit = event.commit;
        return {
          kind: "commit",
          did: event.did,
          collection: commit.collection,
          rkey: commit.rkey,
          operation: commit.operation,
          ...(commit.operation === "delete"
            ? {}
            : { payloadBytes: commit.record.byteLength }),
        };
      });
      yield {
        events,
        checkpoint: batch.lastCursor,
      };
    }
  }

  transportMetrics(): TransportMetrics {
    return this.meter.snapshot();
  }
}
