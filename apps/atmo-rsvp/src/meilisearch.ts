import type {
  ActivationDelivery,
  CurrentRecord,
  DeliveryBatch,
  DeliveryHandlers,
  CurrentBootstrapRuntimeHandlers,
  SnapshotDeliveryPage,
} from "@atmo-dev/contrail";

export const EVENT_COLLECTION = "community.lexicon.calendar.event";
export const SEARCH_CONSUMER_ID = "search";
const CONTROL_ID = "__contrail_generation__";
const EVENT_KIND = "event";
const CONTROL_KIND = "contrail-control";

export interface AtmoMeilisearchEnv {
  MEILI_URL: string;
  MEILI_KEY: string;
  /** Stable serving index UID. Default: `atmo_events`. */
  MEILI_EVENTS_INDEX?: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface AtmoEventDocument extends Record<string, unknown> {
  id: string;
  kind: typeof EVENT_KIND;
  uri: string;
  did: string;
  rkey: string;
  cid: string | null;
  name: string;
  description?: string;
  mode?: string;
  status?: string;
  startsAt?: string;
  endsAt?: string;
  createdAt?: string;
  locations?: unknown[];
  _geo?: GeoPoint;
}

export interface AtmoMeilisearchOptions<Env extends AtmoMeilisearchEnv> {
  fetch?: typeof fetch;
  taskPollMs?: number;
  maxTaskPolls?: number;
  /** Application-owned geocode cache/H3 seam. Direct geo and FSQ coordinates
   * are extracted before this fallback is called. */
  resolveGeo?: (
    record: CurrentRecord,
    env: Env,
    signal: AbortSignal,
  ) => Promise<GeoPoint | null>;
  /** Default excludes explicitly cancelled events. */
  isDiscoverable?: (record: CurrentRecord) => boolean;
}

interface MeiliTaskResponse {
  taskUid?: number;
  uid?: number;
  status?: string;
  error?: { code?: string; message?: string };
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function eventDocumentId(uri: string): string {
  return base64Url(uri);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function coordinate(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function directGeo(value: unknown): GeoPoint | null {
  if (!object(value)) return null;
  const type = string(value.$type);
  if (
    type !== "community.lexicon.location.geo" &&
    type !== "community.lexicon.location.fsq"
  ) {
    return null;
  }
  const lat = coordinate(value.latitude, -90, 90);
  const lng = coordinate(value.longitude, -180, 180);
  return lat === null || lng === null ? null : { lat, lng };
}

export function eventGeo(value: unknown): GeoPoint | null {
  if (!object(value) || !Array.isArray(value.locations)) return null;
  for (const location of value.locations) {
    const geo = directGeo(location);
    if (geo) return geo;
  }
  return null;
}

export function defaultEventDiscoverability(record: CurrentRecord): boolean {
  if (!object(record.value) || typeof record.value.name !== "string") return false;
  return record.value.status !== "community.lexicon.calendar.event#cancelled";
}

export function eventDocument(
  record: CurrentRecord,
  geo: GeoPoint | null = eventGeo(record.value),
): AtmoEventDocument {
  if (!object(record.value) || typeof record.value.name !== "string") {
    throw new Error(`Event ${record.uri} has no valid name`);
  }
  const value = record.value;
  const name = value.name as string;
  return {
    id: eventDocumentId(record.uri),
    kind: EVENT_KIND,
    uri: record.uri,
    did: record.did,
    rkey: record.rkey,
    cid: record.cid,
    name,
    ...(string(value.description) ? { description: string(value.description) } : {}),
    ...(string(value.mode) ? { mode: string(value.mode) } : {}),
    ...(string(value.status) ? { status: string(value.status) } : {}),
    ...(string(value.startsAt) ? { startsAt: string(value.startsAt) } : {}),
    ...(string(value.endsAt) ? { endsAt: string(value.endsAt) } : {}),
    ...(string(value.createdAt) ? { createdAt: string(value.createdAt) } : {}),
    ...(Array.isArray(value.locations) ? { locations: value.locations } : {}),
    ...(geo ? { _geo: geo } : {}),
  };
}

function endpoint(env: AtmoMeilisearchEnv): URL {
  if (typeof env.MEILI_KEY !== "string" || env.MEILI_KEY.length === 0) {
    throw new Error("MEILI_KEY is required");
  }
  if (typeof env.MEILI_URL !== "string" || env.MEILI_URL.length === 0) {
    throw new Error("MEILI_URL is required");
  }
  const url = new URL(env.MEILI_URL);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MEILI_URL cannot contain credentials, query, or fragment");
  }
  return url;
}

function stableIndex(env: AtmoMeilisearchEnv): string {
  return env.MEILI_EVENTS_INDEX?.trim() || "atmo_events";
}

export function candidateIndex(stable: string, token: string): string {
  const suffix = token.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!suffix || suffix.length > 128) throw new Error("Invalid bootstrap token");
  return `${stable}__candidate__${suffix}`;
}

class MeiliClient {
  private readonly opened = new Set<string>();

  constructor(
    private readonly env: AtmoMeilisearchEnv,
    private readonly request: typeof fetch,
    private readonly pollMs: number,
    private readonly maxPolls: number,
  ) {}

  private async fetch(
    path: string,
    init: RequestInit & { signal: AbortSignal },
  ): Promise<Response> {
    const url = new URL(path, endpoint(this.env));
    return this.request(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.env.MEILI_KEY}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  }

  private async json(response: Response, label: string): Promise<any> {
    if (!response.ok) {
      throw new Error(`${label} failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.length > 64_000) throw new Error(`${label} response is too large`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${label} returned malformed JSON`);
    }
  }

  private async task(response: Response, signal: AbortSignal): Promise<void> {
    const accepted = (await this.json(response, "Meilisearch mutation")) as MeiliTaskResponse;
    const uid = accepted.taskUid ?? accepted.uid;
    if (!Number.isSafeInteger(uid)) {
      throw new Error("Meilisearch mutation returned no task UID");
    }
    for (let poll = 0; poll < this.maxPolls; poll++) {
      if (signal.aborted) throw signal.reason ?? new Error("Meilisearch task cancelled");
      const task = (await this.json(
        await this.fetch(`/tasks/${uid}`, { method: "GET", signal }),
        "Meilisearch task",
      )) as MeiliTaskResponse;
      if (task.status === "succeeded") return;
      if (task.status === "failed" || task.status === "canceled") {
        throw new Error(
          `Meilisearch task ${uid} ${task.status}: ${task.error?.code ?? "unknown"}`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, this.pollMs);
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("Meilisearch task cancelled"));
        };
        function done() {
          signal.removeEventListener("abort", abort);
          resolve();
        }
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    throw new Error("Meilisearch task did not finish within its polling budget");
  }

  async ensureIndex(index: string, token: string | null, signal: AbortSignal): Promise<void> {
    const cacheKey = `${index}:${token ?? "stable"}`;
    if (this.opened.has(cacheKey)) return;
    const indexResponse = await this.fetch(`/indexes/${encodeURIComponent(index)}`, {
      method: "GET",
      signal,
    });
    if (indexResponse.status === 404) {
      await this.task(
        await this.fetch("/indexes", {
          method: "POST",
          body: JSON.stringify({ uid: index, primaryKey: "id" }),
          signal,
        }),
        signal,
      );
    } else if (!indexResponse.ok) {
      throw new Error(`Meilisearch index lookup failed with HTTP ${indexResponse.status}`);
    }
    await this.task(
      await this.fetch(`/indexes/${encodeURIComponent(index)}/settings`, {
        method: "PATCH",
        body: JSON.stringify({
          filterableAttributes: ["kind", "did", "mode", "status", "startsAt", "endsAt"],
          sortableAttributes: ["startsAt", "endsAt", "createdAt"],
          searchableAttributes: ["name", "description", "locations"],
        }),
        signal,
      }),
      signal,
    );
    if (token) {
      await this.upsert(
        index,
        [{ id: CONTROL_ID, kind: CONTROL_KIND, generation: token }],
        signal,
      );
    }
    this.opened.add(cacheKey);
  }

  async upsert(index: string, documents: unknown[], signal: AbortSignal): Promise<void> {
    if (documents.length === 0) return;
    await this.task(
      await this.fetch(
        `/indexes/${encodeURIComponent(index)}/documents?primaryKey=id`,
        { method: "POST", body: JSON.stringify(documents), signal },
      ),
      signal,
    );
  }

  async delete(index: string, ids: string[], signal: AbortSignal): Promise<void> {
    if (ids.length === 0) return;
    await this.task(
      await this.fetch(`/indexes/${encodeURIComponent(index)}/documents/delete-batch`, {
        method: "POST",
        body: JSON.stringify(ids),
        signal,
      }),
      signal,
    );
  }

  async marker(index: string, signal: AbortSignal): Promise<string | null> {
    const response = await this.fetch(
      `/indexes/${encodeURIComponent(index)}/documents/${encodeURIComponent(CONTROL_ID)}`,
      { method: "GET", signal },
    );
    if (response.status === 404) return null;
    const value = await this.json(response, "Meilisearch generation marker");
    return typeof value.generation === "string" ? value.generation : null;
  }

  async activate(stable: string, candidate: string, token: string, signal: AbortSignal): Promise<void> {
    await this.ensureIndex(candidate, token, signal);
    if ((await this.marker(stable, signal)) === token) return;
    await this.ensureIndex(stable, "contrail-empty", signal);
    if ((await this.marker(stable, signal)) === token) return;
    if ((await this.marker(candidate, signal)) !== token) {
      throw new Error("Meilisearch candidate has the wrong generation marker");
    }
    await this.task(
      await this.fetch("/swap-indexes", {
        method: "POST",
        body: JSON.stringify([{ indexes: [stable, candidate] }]),
        signal,
      }),
      signal,
    );
    if ((await this.marker(stable, signal)) !== token) {
      throw new Error("Meilisearch activation did not expose the candidate generation");
    }
  }
}

async function documentsFor<Env extends AtmoMeilisearchEnv>(
  records: CurrentRecord[],
  env: Env,
  signal: AbortSignal,
  options: AtmoMeilisearchOptions<Env>,
): Promise<{ documents: AtmoEventDocument[]; hidden: string[] }> {
  const discoverable = options.isDiscoverable ?? defaultEventDiscoverability;
  const documents: AtmoEventDocument[] = [];
  const hidden: string[] = [];
  for (const record of records) {
    if (!discoverable(record)) {
      hidden.push(eventDocumentId(record.uri));
      continue;
    }
    const geo = eventGeo(record.value) ??
      (options.resolveGeo ? await options.resolveGeo(record, env, signal) : null);
    documents.push(eventDocument(record, geo));
  }
  return { documents, hidden };
}

export function createAtmoMeilisearchRuntime<Env extends AtmoMeilisearchEnv>(
  options: AtmoMeilisearchOptions<Env> = {},
): {
  deliveries: DeliveryHandlers<Env>;
  changeBootstraps: CurrentBootstrapRuntimeHandlers<Env>;
} {
  const clients = new WeakMap<object, MeiliClient>();
  const client = (env: Env) => {
    const key = env as object;
    let value = clients.get(key);
    if (!value) {
      value = new MeiliClient(
        env,
        options.fetch ?? fetch,
        options.taskPollMs ?? 100,
        options.maxTaskPolls ?? 300,
      );
      clients.set(key, value);
    }
    return value;
  };

  const deliver = async (
    batch: DeliveryBatch,
    env: Env,
    signal: AbortSignal,
  ) => {
    const meili = client(env);
    const stable = stableIndex(env);
    const index = batch.destinationToken
      ? candidateIndex(stable, batch.destinationToken)
      : stable;
    await meili.ensureIndex(index, batch.destinationToken ?? null, signal);
    const { documents, hidden } = await documentsFor(
      batch.currentRecords,
      env,
      signal,
      options,
    );
    const absent = batch.absentUris.map(eventDocumentId);
    await meili.upsert(index, documents, signal);
    await meili.delete(index, [...new Set([...hidden, ...absent])], signal);
  };

  return {
    deliveries: {
      [SEARCH_CONSUMER_ID]: async (batch, { env, signal }) => {
        await deliver(batch, env, signal);
      },
    },
    changeBootstraps: {
      [SEARCH_CONSUMER_ID]: {
        snapshot: async (page: SnapshotDeliveryPage, { env, signal }) => {
          const meili = client(env);
          const stable = stableIndex(env);
          const index = candidateIndex(stable, page.bootstrapToken);
          await meili.ensureIndex(index, page.bootstrapToken, signal);
          const { documents, hidden } = await documentsFor(
            page.records,
            env,
            signal,
            options,
          );
          await meili.upsert(index, documents, signal);
          await meili.delete(index, hidden, signal);
        },
        activate: async (activation: ActivationDelivery, { env, signal }) => {
          const stable = stableIndex(env);
          await client(env).activate(
            stable,
            candidateIndex(stable, activation.bootstrapToken),
            activation.bootstrapToken,
            signal,
          );
        },
      },
    },
  };
}
