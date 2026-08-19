import { encode } from "@atcute/cbor";
import {
  MeteredFetch,
  type SourceBatch,
  type SourceEvent,
  type SourceLoader,
  type SourceLoadOptions,
  type TransportMetrics,
} from "./source-loader.ts";

export const DEFAULT_RELAY = "https://relay1.us-east.bsky.network";
export const DEFAULT_SLINGSHOT =
  "https://slingshot.microcosm.blue/xrpc/com.bad-example.identity.resolveMiniDoc";

export interface RelayPdsSourceOptions {
  relay?: string;
  slingshot?: string;
  collection: string;
  resolutionConcurrency?: number;
  pdsConcurrency?: number;
  didsPerPds?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface DiscoveryPage {
  repos: Array<{ did: string }>;
  cursor?: string;
}

interface ListRecordsPage {
  records: Array<{
    uri: string;
    cid: string;
    value: unknown;
  }>;
  cursor?: string;
}

interface ResolvedActor {
  did: string;
  pds: string;
}

interface RelayPdsDiagnostics {
  timings_ms: {
    discovery: number;
    resolution: number;
    list_records: number;
  };
  discovery: {
    pages: number;
    repos: number;
    unique_dids: number;
    duplicate_dids: number;
  };
  resolution: {
    attempted: number;
    resolved: number;
    unresolved: number;
    fallback_attempted: number;
    fallback_resolved: number;
    pds_hosts: number;
  };
  list_records: {
    attempted_accounts: number;
    complete_accounts: number;
    failed_accounts: number;
    partial_accounts: number;
    pages: number;
    records: number;
    retries: number;
    failure_statuses: Record<string, number>;
    failure_errors: Record<string, number>;
    transport_failures: number;
    timeout_failures: number;
    malformed_failures: number;
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function isDid(value: unknown): value is string {
  return typeof value === "string" && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value);
}

function validExternalUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
      return false;
    }
    if (
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function didDocumentUrl(did: string): URL | null {
  if (did.startsWith("did:plc:")) {
    return new URL(`/${did}`, "https://plc.directory");
  }
  if (!did.startsWith("did:web:")) return null;
  let parts: string[];
  try {
    parts = did.slice("did:web:".length).split(":").map(decodeURIComponent);
  } catch {
    return null;
  }
  const host = parts.shift();
  if (!host) return null;
  const path = parts.length === 0
    ? "/.well-known/did.json"
    : `/${parts.map(encodeURIComponent).join("/")}/did.json`;
  return new URL(path, `https://${host}`);
}

function pdsFromDidDocument(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const services = (value as { service?: unknown }).service;
  if (!Array.isArray(services)) return null;
  for (const service of services) {
    if (!service || typeof service !== "object") continue;
    const item = service as {
      id?: unknown;
      type?: unknown;
      serviceEndpoint?: unknown;
    };
    if (
      (item.id === "#atproto_pds" ||
        (typeof item.id === "string" && item.id.endsWith("#atproto_pds"))) &&
      (item.type === undefined || item.type === "AtprotoPersonalDataServer") &&
      validExternalUrl(item.serviceEndpoint)
    ) {
      return new URL(item.serviceEndpoint).origin;
    }
  }
  return null;
}

class HttpStatusError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, label: string, error?: string) {
    super(`${label} returned HTTP ${status}${error ? ` (${error})` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.error = error ?? "unknown";
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<() => void> = [];
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended) throw new Error("Cannot push to a closed source queue");
    this.values.push(value);
    this.waiters.shift()?.();
  }

  close(): void {
    this.ended = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const value = this.values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      if (this.ended) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Current-state loader using relay collection discovery followed by direct PDS
 * listRecords calls. Every request gets exactly one attempt. */
export class RelayPdsSource implements SourceLoader {
  readonly id = "relay-pds";
  readonly service: string;
  private readonly meter: MeteredFetch;
  private readonly relay: string;
  private readonly slingshot: string;
  private readonly resolutionConcurrency: number;
  private readonly pdsConcurrency: number;
  private readonly didsPerPds: number;
  private readonly requestTimeoutMs: number;
  private readonly options: RelayPdsSourceOptions;
  private readonly stats: RelayPdsDiagnostics = {
    timings_ms: { discovery: 0, resolution: 0, list_records: 0 },
    discovery: { pages: 0, repos: 0, unique_dids: 0, duplicate_dids: 0 },
    resolution: {
      attempted: 0,
      resolved: 0,
      unresolved: 0,
      fallback_attempted: 0,
      fallback_resolved: 0,
      pds_hosts: 0,
    },
    list_records: {
      attempted_accounts: 0,
      complete_accounts: 0,
      failed_accounts: 0,
      partial_accounts: 0,
      pages: 0,
      records: 0,
      retries: 0,
      failure_statuses: {},
      failure_errors: {},
      transport_failures: 0,
      timeout_failures: 0,
      malformed_failures: 0,
    },
  };

  constructor(options: RelayPdsSourceOptions) {
    this.options = options;
    this.relay = new URL(options.relay ?? DEFAULT_RELAY).origin;
    this.service = this.relay;
    this.slingshot = new URL(options.slingshot ?? DEFAULT_SLINGSHOT).toString();
    this.resolutionConcurrency = positive(options.resolutionConcurrency, 100);
    this.pdsConcurrency = positive(options.pdsConcurrency, 20);
    this.didsPerPds = positive(options.didsPerPds, 3);
    this.requestTimeoutMs = positive(options.requestTimeoutMs, 10_000);
    this.meter = new MeteredFetch(options.fetchImpl, {
      groupByHost: false,
    });
  }

  async *load(options: SourceLoadOptions = {}): AsyncIterable<SourceBatch> {
    const queue = new AsyncQueue<SourceBatch>();
    void this.run(queue, options.signal).then(
      () => queue.close(),
      (error) => queue.fail(error),
    );
    yield* queue;
  }

  transportMetrics(): TransportMetrics {
    return this.meter.snapshot();
  }

  diagnostics(): Record<string, unknown> {
    return {
      ...this.stats,
      configuration: {
        collection: this.options.collection,
        relay: this.relay,
        slingshot: new URL(this.slingshot).origin,
        resolution_concurrency: this.resolutionConcurrency,
        pds_concurrency: this.pdsConcurrency,
        dids_per_pds: this.didsPerPds,
        request_timeout_ms: this.requestTimeoutMs,
        retries: 0,
      },
    };
  }

  private async run(queue: AsyncQueue<SourceBatch>, signal?: AbortSignal): Promise<void> {
    let phaseStart = performance.now();
    const dids = await this.discover(signal);
    this.stats.timings_ms.discovery = round(performance.now() - phaseStart);

    phaseStart = performance.now();
    const resolved = await this.resolveAll(dids, signal);
    this.stats.timings_ms.resolution = round(performance.now() - phaseStart);

    const byPds = new Map<string, string[]>();
    for (const actor of resolved) {
      const values = byPds.get(actor.pds) ?? [];
      values.push(actor.did);
      byPds.set(actor.pds, values);
    }
    this.stats.resolution.pds_hosts = byPds.size;

    phaseStart = performance.now();
    await this.loadHosts([...byPds.entries()], queue, signal);
    this.stats.timings_ms.list_records = round(performance.now() - phaseStart);
  }

  private async discover(signal?: AbortSignal): Promise<string[]> {
    const dids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const url = new URL(
        "/xrpc/com.atproto.sync.listReposByCollection",
        this.relay,
      );
      url.searchParams.set("collection", this.options.collection);
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("cursor", cursor);
      const body = await this.fetchJson(url, "listReposByCollection", signal);
      const page = this.parseDiscoveryPage(body);
      this.stats.discovery.pages++;
      this.stats.discovery.repos += page.repos.length;
      for (const repo of page.repos) {
        if (dids.has(repo.did)) this.stats.discovery.duplicate_dids++;
        else dids.add(repo.did);
      }
      if (!page.cursor) break;
      if (cursors.has(page.cursor)) {
        throw new Error("listReposByCollection cursor did not advance");
      }
      cursors.add(page.cursor);
      cursor = page.cursor;
    }
    this.stats.discovery.unique_dids = dids.size;
    return [...dids];
  }

  private parseDiscoveryPage(value: unknown): DiscoveryPage {
    if (!value || typeof value !== "object") {
      throw new Error("Malformed listReposByCollection response");
    }
    const page = value as { repos?: unknown; cursor?: unknown };
    if (
      !Array.isArray(page.repos) ||
      !page.repos.every(
        (repo) =>
          repo &&
          typeof repo === "object" &&
          isDid((repo as { did?: unknown }).did),
      ) ||
      (page.cursor !== undefined && typeof page.cursor !== "string")
    ) {
      throw new Error("Malformed listReposByCollection response");
    }
    return page as DiscoveryPage;
  }

  private async resolveAll(
    dids: string[],
    signal?: AbortSignal,
  ): Promise<ResolvedActor[]> {
    const resolved: ResolvedActor[] = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.resolutionConcurrency, dids.length) },
      async () => {
        for (;;) {
          const index = next++;
          if (index >= dids.length) return;
          const did = dids[index]!;
          this.stats.resolution.attempted++;
          const pds = await this.resolvePds(did, signal);
          if (pds) {
            this.stats.resolution.resolved++;
            resolved.push({ did, pds });
          } else {
            this.stats.resolution.unresolved++;
          }
        }
      },
    );
    await Promise.all(workers);
    return resolved;
  }

  private async resolvePds(
    did: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const slingshot = new URL(this.slingshot);
    slingshot.searchParams.set("identifier", did);
    try {
      const body = await this.fetchJson(slingshot, "slingshot", signal);
      const pds = (body as { pds?: unknown } | null)?.pds;
      if (validExternalUrl(pds)) return new URL(pds).origin;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
    }

    this.stats.resolution.fallback_attempted++;
    const documentUrl = didDocumentUrl(did);
    if (!documentUrl) return null;
    try {
      const body = await this.fetchJson(documentUrl, "DID document", signal);
      const pds = pdsFromDidDocument(body);
      if (pds) this.stats.resolution.fallback_resolved++;
      return pds;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return null;
    }
  }

  private async loadHosts(
    hosts: Array<[string, string[]]>,
    queue: AsyncQueue<SourceBatch>,
    signal?: AbortSignal,
  ): Promise<void> {
    let nextHost = 0;
    const workers = Array.from(
      { length: Math.min(this.pdsConcurrency, hosts.length) },
      async () => {
        for (;;) {
          const index = nextHost++;
          if (index >= hosts.length) return;
          const [pds, dids] = hosts[index]!;
          let nextDid = 0;
          const didWorkers = Array.from(
            { length: Math.min(this.didsPerPds, dids.length) },
            async () => {
              for (;;) {
                const didIndex = nextDid++;
                if (didIndex >= dids.length) return;
                await this.loadDid(pds, dids[didIndex]!, queue, signal);
              }
            },
          );
          await Promise.all(didWorkers);
        }
      },
    );
    await Promise.all(workers);
  }

  private async loadDid(
    pds: string,
    did: string,
    queue: AsyncQueue<SourceBatch>,
    signal?: AbortSignal,
  ): Promise<void> {
    this.stats.list_records.attempted_accounts++;
    let cursor: string | undefined;
    let records = 0;
    const cursors = new Set<string>();
    try {
      for (;;) {
        const url = new URL("/xrpc/com.atproto.repo.listRecords", pds);
        url.searchParams.set("repo", did);
        url.searchParams.set("collection", this.options.collection);
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("cursor", cursor);
        const body = await this.fetchJson(url, "listRecords", signal);
        const page = this.parseListRecordsPage(body, did);
        this.stats.list_records.pages++;
        this.stats.list_records.records += page.records.length;
        records += page.records.length;
        const events: SourceEvent[] = page.records.map((record) => ({
          kind: "commit",
          did,
          collection: this.options.collection,
          rkey: record.uri.slice(record.uri.lastIndexOf("/") + 1),
          operation: "create",
          payloadBytes: encode(record.value).byteLength,
        }));
        queue.push({
          events,
          checkpoint: `${did}:${page.cursor ?? "complete"}`,
        });
        if (!page.cursor) break;
        if (cursors.has(page.cursor)) {
          throw new Error("listRecords cursor did not advance");
        }
        cursors.add(page.cursor);
        cursor = page.cursor;
      }
      this.stats.list_records.complete_accounts++;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      this.stats.list_records.failed_accounts++;
      if (records > 0) this.stats.list_records.partial_accounts++;
      if (error instanceof HttpStatusError) {
        const status = String(error.status);
        const statuses = this.stats.list_records.failure_statuses;
        statuses[status] = (statuses[status] ?? 0) + 1;
        const errors = this.stats.list_records.failure_errors;
        errors[error.error] = (errors[error.error] ?? 0) + 1;
      } else if (error instanceof DOMException && error.name === "TimeoutError") {
        this.stats.list_records.timeout_failures++;
      } else if (
        error instanceof Error &&
        (error.message.startsWith("Malformed listRecords") ||
          error.message.includes("cursor did not advance"))
      ) {
        this.stats.list_records.malformed_failures++;
      } else {
        this.stats.list_records.transport_failures++;
      }
    }
  }

  private parseListRecordsPage(value: unknown, did: string): ListRecordsPage {
    if (!value || typeof value !== "object") {
      throw new Error("Malformed listRecords response");
    }
    const page = value as { records?: unknown; cursor?: unknown };
    const uriPrefix = `at://${did}/${this.options.collection}/`;
    if (
      !Array.isArray(page.records) ||
      !page.records.every((record) => {
        if (!record || typeof record !== "object") return false;
        const item = record as { uri?: unknown; cid?: unknown; value?: unknown };
        return (
          typeof item.uri === "string" &&
          item.uri.startsWith(uriPrefix) &&
          item.uri.length > uriPrefix.length &&
          typeof item.cid === "string" &&
          item.value !== null &&
          typeof item.value === "object"
        );
      }) ||
      (page.cursor !== undefined && typeof page.cursor !== "string")
    ) {
      throw new Error("Malformed listRecords response");
    }
    return page as ListRecordsPage;
  }

  private async fetchJson(
    url: URL,
    label: string,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    parentSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, timeout])
      : timeout;
    const response = await this.meter.fetch(url, { signal });
    if (!response.ok) {
      const text = await response.text();
      let error: string | undefined;
      try {
        const value = JSON.parse(text) as { error?: unknown };
        if (typeof value.error === "string") error = value.error;
      } catch {
        // Non-XRPC error body; retain only the status.
      }
      throw new HttpStatusError(response.status, label, error);
    }
    return response.json();
  }
}
