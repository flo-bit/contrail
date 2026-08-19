import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_JETSTREAM_V2_SERVICE,
  JetstreamV2Source,
} from "./jetstream-v2-source.ts";
import {
  DEFAULT_RELAY,
  RelayPdsSource,
} from "./relay-pds-source.ts";
import type {
  SourceEvent,
  SourceLoader,
} from "./source-loader.ts";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(APP_DIR, "results");
const DEFAULT_COLLECTION = "xyz.statusphere.status";
const JETSTREAM_SDK_VERSION = "1.0.0";
const MIB = 1024 * 1024;

type SourceName = "jetstream-v2" | "relay-pds";

interface Options {
  source: SourceName;
  collection: string;
  service: string;
  afterSeq: number;
  beforeSeq?: number;
  blockConcurrency: number;
  bufferMiB: number;
  lifecycle: boolean;
  resolutionConcurrency: number;
  pdsConcurrency: number;
  didsPerPds: number;
  requestTimeoutMs: number;
}

function integer(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum} (got ${raw})`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  let source: SourceName = "jetstream-v2";
  let collection = DEFAULT_COLLECTION;
  let serviceRaw: string | undefined;
  let afterSeqRaw: string | undefined;
  let beforeSeqRaw: string | undefined;
  let blockConcurrencyRaw: string | undefined;
  let bufferMiBRaw: string | undefined;
  let resolutionConcurrencyRaw: string | undefined;
  let pdsConcurrencyRaw: string | undefined;
  let didsPerPdsRaw: string | undefined;
  let requestTimeoutRaw: string | undefined;
  let lifecycle = true;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") continue;
    if (arg === "--source" || arg.startsWith("--source=")) {
      const value = arg === "--source" ? argv[++index] : arg.slice("--source=".length);
      if (value !== "jetstream-v2" && value !== "relay-pds") {
        throw new Error(`--source must be jetstream-v2 or relay-pds (got ${value})`);
      }
      source = value;
    } else if (arg === "--collection") collection = argv[++index] ?? "";
    else if (arg.startsWith("--collection=")) {
      collection = arg.slice("--collection=".length);
    } else if (arg === "--service" || arg === "--relay") {
      serviceRaw = argv[++index] ?? "";
    } else if (arg.startsWith("--service=")) {
      serviceRaw = arg.slice("--service=".length);
    } else if (arg.startsWith("--relay=")) {
      serviceRaw = arg.slice("--relay=".length);
    } else if (arg === "--after-seq") afterSeqRaw = argv[++index];
    else if (arg.startsWith("--after-seq=")) {
      afterSeqRaw = arg.slice("--after-seq=".length);
    } else if (arg === "--before-seq") beforeSeqRaw = argv[++index];
    else if (arg.startsWith("--before-seq=")) {
      beforeSeqRaw = arg.slice("--before-seq=".length);
    } else if (arg === "--block-concurrency") {
      blockConcurrencyRaw = argv[++index];
    } else if (arg.startsWith("--block-concurrency=")) {
      blockConcurrencyRaw = arg.slice("--block-concurrency=".length);
    } else if (arg === "--buffer-mib") bufferMiBRaw = argv[++index];
    else if (arg.startsWith("--buffer-mib=")) {
      bufferMiBRaw = arg.slice("--buffer-mib=".length);
    } else if (arg === "--resolution-concurrency") {
      resolutionConcurrencyRaw = argv[++index];
    } else if (arg.startsWith("--resolution-concurrency=")) {
      resolutionConcurrencyRaw = arg.slice("--resolution-concurrency=".length);
    } else if (arg === "--pds-concurrency") {
      pdsConcurrencyRaw = argv[++index];
    } else if (arg.startsWith("--pds-concurrency=")) {
      pdsConcurrencyRaw = arg.slice("--pds-concurrency=".length);
    } else if (arg === "--dids-per-pds") didsPerPdsRaw = argv[++index];
    else if (arg.startsWith("--dids-per-pds=")) {
      didsPerPdsRaw = arg.slice("--dids-per-pds=".length);
    } else if (arg === "--request-timeout-ms") {
      requestTimeoutRaw = argv[++index];
    } else if (arg.startsWith("--request-timeout-ms=")) {
      requestTimeoutRaw = arg.slice("--request-timeout-ms=".length);
    } else if (arg === "--commits-only") lifecycle = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: pnpm bench:source [options]

Options:
  --source <name>             jetstream-v2 (default) or relay-pds
  --collection <nsid>         Collection to load (default: ${DEFAULT_COLLECTION})
  --service <url>             Jetstream service or relay URL
  --relay <url>               Alias for --service with relay-pds

Jetstream v2:
  --after-seq <n>             Exclusive lower sequence bound (default: 0)
  --before-seq <n>            Optional inclusive upper sequence bound
  --block-concurrency <n>     Concurrent archive block downloads (default: 4)
  --buffer-mib <n>            SDK snapshot buffer budget (default: 64)
  --commits-only              Exclude account-delete and sync markers

Relay + PDS (every request gets one attempt; no retries):
  --resolution-concurrency <n> Concurrent PDS resolutions (default: 100)
  --pds-concurrency <n>       Concurrent PDS hosts (default: 20)
  --dids-per-pds <n>          Concurrent accounts per PDS (default: 3)
  --request-timeout-ms <n>    Timeout for each request (default: 10000)

Hosted Jetstream snapshots require JETSTREAM_API_KEY. Relay + PDS does not.
Results are written to apps/benchmark/results/.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!collection) throw new Error("--collection is required");
  const service = serviceRaw ?? (
    source === "jetstream-v2" ? DEFAULT_JETSTREAM_V2_SERVICE : DEFAULT_RELAY
  );
  const parsedService = new URL(service);
  if (parsedService.protocol !== "https:" && parsedService.protocol !== "http:") {
    throw new Error("--service must be an HTTP(S) URL");
  }
  const afterSeq = integer(afterSeqRaw, "--after-seq", 0, 0);
  const beforeSeq = beforeSeqRaw === undefined
    ? undefined
    : integer(beforeSeqRaw, "--before-seq", 0, 1);
  if (beforeSeq !== undefined && beforeSeq <= afterSeq) {
    throw new Error("--before-seq must be greater than --after-seq");
  }

  return {
    source,
    collection,
    service: parsedService.origin,
    afterSeq,
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    blockConcurrency: integer(blockConcurrencyRaw, "--block-concurrency", 4, 1),
    bufferMiB: integer(bufferMiBRaw, "--buffer-mib", 64, 1),
    lifecycle,
    resolutionConcurrency: integer(
      resolutionConcurrencyRaw,
      "--resolution-concurrency",
      100,
      1,
    ),
    pdsConcurrency: integer(pdsConcurrencyRaw, "--pds-concurrency", 20, 1),
    didsPerPds: integer(didsPerPdsRaw, "--dids-per-pds", 3, 1),
    requestTimeoutMs: integer(
      requestTimeoutRaw,
      "--request-timeout-ms",
      10_000,
      1,
    ),
  };
}

interface EventCounts {
  batches: number;
  empty_batches: number;
  total: number;
  commits: number;
  creates: number;
  updates: number;
  deletes: number;
  accounts: number;
  deleted_accounts: number;
  syncs: number;
  records_removed_by_account: number;
  records_removed_by_sync: number;
}

class CollectionFold {
  readonly counts: EventCounts = {
    batches: 0,
    empty_batches: 0,
    total: 0,
    commits: 0,
    creates: 0,
    updates: 0,
    deletes: 0,
    accounts: 0,
    deleted_accounts: 0,
    syncs: 0,
    records_removed_by_account: 0,
    records_removed_by_sync: 0,
  };
  readonly recordBytes = new Map<string, number>();
  readonly recordsByDid = new Map<string, Set<string>>();
  put_payload_bytes = 0;
  current_payload_bytes = 0;
  last_checkpoint: number | string | null = null;
  private readonly collection: string;

  constructor(collection: string) {
    this.collection = collection;
  }

  applyBatch(
    events: SourceEvent[],
    checkpoint: number | string | null,
  ): void {
    this.counts.batches++;
    if (events.length === 0) this.counts.empty_batches++;
    this.last_checkpoint = checkpoint;
    for (const event of events) this.apply(event);
  }

  private apply(event: SourceEvent): void {
    this.counts.total++;
    if (event.kind === "account") {
      this.counts.accounts++;
      if (!event.active && event.status === "deleted") {
        this.counts.deleted_accounts++;
        this.counts.records_removed_by_account += this.removeDid(event.did);
      }
      return;
    }
    if (event.kind === "sync") {
      this.counts.syncs++;
      this.counts.records_removed_by_sync += this.removeDid(event.did);
      return;
    }

    if (event.collection !== this.collection) {
      throw new Error(
        `Source delivered unexpected commit collection ${event.collection}`,
      );
    }
    this.counts.commits++;
    const uri = `at://${event.did}/${event.collection}/${event.rkey}`;
    if (event.operation === "delete") {
      this.counts.deletes++;
      this.removeUri(uri, event.did);
      return;
    }

    if (event.payloadBytes === undefined) {
      throw new TypeError(`Source omitted payload size for ${uri}`);
    }
    if (event.operation === "create") this.counts.creates++;
    else this.counts.updates++;
    this.put_payload_bytes += event.payloadBytes;
    const prior = this.recordBytes.get(uri) ?? 0;
    this.recordBytes.set(uri, event.payloadBytes);
    this.current_payload_bytes += event.payloadBytes - prior;
    const uris = this.recordsByDid.get(event.did) ?? new Set<string>();
    uris.add(uri);
    this.recordsByDid.set(event.did, uris);
  }

  private removeUri(uri: string, did: string): boolean {
    const bytes = this.recordBytes.get(uri);
    if (bytes === undefined) return false;
    this.recordBytes.delete(uri);
    this.current_payload_bytes -= bytes;
    const uris = this.recordsByDid.get(did);
    uris?.delete(uri);
    if (uris?.size === 0) this.recordsByDid.delete(did);
    return true;
  }

  private removeDid(did: string): number {
    const uris = this.recordsByDid.get(did);
    if (!uris) return 0;
    let removed = 0;
    for (const uri of [...uris]) {
      if (this.removeUri(uri, did)) removed++;
    }
    return removed;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

function createSource(options: Options): {
  source: SourceLoader;
  descriptor: Record<string, unknown>;
  resultOptions: Record<string, unknown>;
} {
  if (options.source === "relay-pds") {
    const source = new RelayPdsSource({
      relay: options.service,
      collection: options.collection,
      resolutionConcurrency: options.resolutionConcurrency,
      pdsConcurrency: options.pdsConcurrency,
      didsPerPds: options.didsPerPds,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    return {
      source,
      descriptor: {
        id: source.id,
        service: source.service,
        protocols: [
          "com.atproto.sync.listReposByCollection",
          "com.atproto.repo.listRecords",
        ],
      },
      resultOptions: {
        resolution_concurrency: options.resolutionConcurrency,
        pds_concurrency: options.pdsConcurrency,
        dids_per_pds: options.didsPerPds,
        request_timeout_ms: options.requestTimeoutMs,
        retries: 0,
      },
    };
  }

  const apiKey = process.env.JETSTREAM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "JETSTREAM_API_KEY is required for hosted Jetstream v2 snapshots. " +
        "Create one at https://bsky.network/account#api-keys-section-heading",
    );
  }
  const source = new JetstreamV2Source({
    service: options.service,
    apiKey,
    collection: options.collection,
    afterSeq: options.afterSeq,
    ...(options.beforeSeq === undefined
      ? {}
      : { beforeSeq: options.beforeSeq }),
    blockConcurrency: options.blockConcurrency,
    snapshotBufferBytes: options.bufferMiB * MIB,
    lifecycle: options.lifecycle,
  });
  return {
    source,
    descriptor: {
      id: source.id,
      service: source.service,
      sdk: `@bsky/jetstream@${JETSTREAM_SDK_VERSION}`,
    },
    resultOptions: {
      after_seq: options.afterSeq,
      before_seq: options.beforeSeq ?? null,
      block_concurrency: options.blockConcurrency,
      snapshot_buffer_mib: options.bufferMiB,
      lifecycle_markers: options.lifecycle,
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { source, descriptor, resultOptions } = createSource(options);
  const fold = new CollectionFold(options.collection);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Benchmark interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  console.log(
    `source:       ${source.id}${
      source.id === "jetstream-v2"
        ? ` (@bsky/jetstream ${JETSTREAM_SDK_VERSION})`
        : " (single-attempt relay/PDS)"
    }`,
  );
  console.log(`service:      ${source.service}`);
  console.log(`collection:   ${options.collection}`);
  if (source.id === "jetstream-v2") {
    console.log(
      `window:       (${options.afterSeq}, ${options.beforeSeq ?? "sealed tip"}]`,
    );
    console.log(`block fetches: ${options.blockConcurrency} concurrent`);
    console.log(`buffer:       ${options.bufferMiB} MiB`);
    console.log(
      `lifecycle:    ${options.lifecycle ? "account deletes + sync markers" : "commits only"}`,
    );
  } else {
    console.log(`resolution:   ${options.resolutionConcurrency} concurrent`);
    console.log(`PDS hosts:    ${options.pdsConcurrency} concurrent`);
    console.log(`DIDs / PDS:   ${options.didsPerPds} concurrent`);
    console.log(`retries:      0`);
  }

  const startedAt = new Date();
  const start = performance.now();
  let lastProgressAt = start;
  try {
    for await (const batch of source.load({ signal: controller.signal })) {
      fold.applyBatch(batch.events, batch.checkpoint);
      const now = performance.now();
      if (now - lastProgressAt < 2_000) continue;
      lastProgressAt = now;
      const seconds = (now - start) / 1000;
      const transport = source.transportMetrics();
      console.log(
        `progress:     ${seconds.toFixed(1)}s, ${fold.counts.commits.toLocaleString("en-US")} records, ` +
          `${formatBytes(transport.response_bytes)} at ${formatBytes(transport.response_bytes / seconds)}/s`,
      );
    }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }

  const completedAt = new Date();
  const elapsedMs = performance.now() - start;
  const seconds = elapsedMs / 1000;
  const transport = source.transportMetrics();
  const diagnostics = source.diagnostics?.() ?? null;
  const result = {
    format: "contrail.source-benchmark",
    version: 1,
    source: descriptor,
    collection: options.collection,
    options: resultOptions,
    runtime: {
      node: process.version,
    },
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    timings_ms: {
      load: round(elapsedMs),
    },
    events: fold.counts,
    last_checkpoint: fold.last_checkpoint,
    current_state: {
      records: fold.recordBytes.size,
      actors: fold.recordsByDid.size,
    },
    data: {
      downloaded_bytes: transport.response_bytes,
      response_content_length_bytes: transport.content_length_bytes,
      measurement: "response body bytes consumed after HTTP content decoding",
      put_record_payload_bytes: fold.put_payload_bytes,
      current_record_payload_bytes: fold.current_payload_bytes,
      record_payload_encoding: "dag-cbor",
    },
    throughput: {
      downloaded_mib_per_second: round(
        transport.response_bytes / MIB / seconds,
      ),
      source_events_per_second: round(fold.counts.total / seconds),
      commits_per_second: round(fold.counts.commits / seconds),
      put_record_payload_mib_per_second: round(
        fold.put_payload_bytes / MIB / seconds,
      ),
      put_record_payload_kib_per_second: round(
        fold.put_payload_bytes / 1024 / seconds,
      ),
    },
    efficiency: {
      downloaded_bytes_per_commit:
        fold.counts.commits === 0
          ? null
          : round(transport.response_bytes / fold.counts.commits),
      put_payload_bytes_per_commit:
        fold.counts.commits === 0
          ? null
          : round(fold.put_payload_bytes / fold.counts.commits),
      put_payload_to_download_percent:
        transport.response_bytes === 0
          ? null
          : round((fold.put_payload_bytes / transport.response_bytes) * 100),
    },
    source_diagnostics: diagnostics,
    transport,
    peak_rss_kib: process.resourceUsage().maxRSS,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  const timestamp = completedAt.toISOString().replace(/[:.]/g, "-");
  const resultPath = resolve(
    RESULTS_DIR,
    `${source.id}-${safeName(options.collection)}-${timestamp}.json`,
  );
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log("");
  console.log(`time:         ${seconds.toFixed(2)}s`);
  console.log(`downloaded:   ${formatBytes(transport.response_bytes)}`);
  console.log(
    `average:      ${result.throughput.downloaded_mib_per_second.toFixed(2)} MiB/s`,
  );
  console.log(
    `records:      ${fold.counts.commits.toLocaleString("en-US")} ` +
      `(${result.throughput.commits_per_second.toFixed(2)}/s)`,
  );
  console.log(
    `current:      ${fold.recordBytes.size.toLocaleString("en-US")} records, ` +
      `${fold.recordsByDid.size.toLocaleString("en-US")} actors, ` +
      `${formatBytes(fold.current_payload_bytes)} DAG-CBOR payload`,
  );
  if (source.id === "jetstream-v2") {
    console.log(
      `operations:   ${fold.counts.creates.toLocaleString("en-US")} create, ` +
        `${fold.counts.updates.toLocaleString("en-US")} update, ` +
        `${fold.counts.deletes.toLocaleString("en-US")} delete`,
    );
  } else {
    const values = diagnostics as {
      discovery?: { unique_dids?: number };
      resolution?: { resolved?: number; unresolved?: number };
      list_records?: {
        complete_accounts?: number;
        failed_accounts?: number;
        partial_accounts?: number;
      };
    } | null;
    console.log(
      `discovery:    ${values?.discovery?.unique_dids ?? 0} DIDs, ` +
        `${values?.resolution?.resolved ?? 0} resolved, ` +
        `${values?.resolution?.unresolved ?? 0} unresolved`,
    );
    console.log(
      `accounts:     ${values?.list_records?.complete_accounts ?? 0} complete, ` +
        `${values?.list_records?.failed_accounts ?? 0} failed, ` +
        `${values?.list_records?.partial_accounts ?? 0} partial`,
    );
  }
  console.log(`requests:     ${transport.requests} HTTP (${transport.errors} transport errors)`);
  console.log(`result:       ${resultPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
