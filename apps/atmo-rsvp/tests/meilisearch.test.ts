import { describe, expect, it } from "vitest";
import type {
  ActivationDelivery,
  CurrentRecord,
  DeliveryBatch,
  SnapshotDeliveryPage,
} from "@atmo-dev/contrail";
import {
  candidateIndex,
  createAtmoMeilisearchRuntime,
  defaultEventDiscoverability,
  eventDocument,
  eventDocumentId,
  eventGeo,
  type AtmoMeilisearchEnv,
} from "../src/meilisearch";

class FakeMeili {
  indexes = new Map<string, Map<string, any>>();
  tasks = new Map<number, "succeeded" | "failed">();
  nextTask = 1;
  failNext = false;
  swaps = 0;

  task(apply?: () => void): Response {
    const uid = this.nextTask++;
    const status = this.failNext ? "failed" : "succeeded";
    this.failNext = false;
    this.tasks.set(uid, status);
    if (status === "succeeded") apply?.();
    return Response.json({ taskUid: uid }, { status: 202 });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (parts[0] === "tasks" && method === "GET") {
      const status = this.tasks.get(Number(parts[1]));
      return status
        ? Response.json({
            uid: Number(parts[1]),
            status,
            ...(status === "failed" ? { error: { code: "fake_failure" } } : {}),
          })
        : new Response(null, { status: 404 });
    }
    if (url.pathname === "/indexes" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      return this.task(() => this.indexes.set(body.uid, new Map()));
    }
    if (url.pathname === "/swap-indexes" && method === "POST") {
      const [{ indexes }] = JSON.parse(String(init?.body));
      return this.task(() => {
        const first = this.indexes.get(indexes[0]) ?? new Map();
        const second = this.indexes.get(indexes[1]) ?? new Map();
        this.indexes.set(indexes[0], second);
        this.indexes.set(indexes[1], first);
        this.swaps++;
      });
    }
    if (parts[0] !== "indexes" || !parts[1]) {
      return new Response(null, { status: 404 });
    }
    const index = parts[1];
    if (parts.length === 2 && method === "GET") {
      return this.indexes.has(index)
        ? Response.json({ uid: index, primaryKey: "id" })
        : new Response(null, { status: 404 });
    }
    if (parts[2] === "settings" && method === "PATCH") {
      return this.task();
    }
    if (parts[2] === "documents" && parts.length === 3 && method === "POST") {
      const documents = JSON.parse(String(init?.body));
      return this.task(() => {
        const target = this.indexes.get(index)!;
        for (const document of documents) target.set(document.id, document);
      });
    }
    if (
      parts[2] === "documents" &&
      parts[3] === "delete-batch" &&
      method === "POST"
    ) {
      const ids = JSON.parse(String(init?.body));
      return this.task(() => {
        const target = this.indexes.get(index)!;
        for (const id of ids) target.delete(id);
      });
    }
    if (parts[2] === "documents" && parts[3] && method === "GET") {
      const document = this.indexes.get(index)?.get(parts[3]);
      return document
        ? Response.json(document)
        : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  };
}

const env: AtmoMeilisearchEnv = {
  MEILI_URL: "https://meili.example/",
  MEILI_KEY: "secret",
  MEILI_EVENTS_INDEX: "events",
};

function record(options: {
  uri?: string;
  name?: string;
  status?: string;
  locations?: unknown[];
} = {}): CurrentRecord {
  const uri = options.uri ?? "at://did:plc:alice/community.lexicon.calendar.event/one";
  return {
    uri,
    did: "did:plc:alice",
    collection: "community.lexicon.calendar.event",
    rkey: uri.split("/").at(-1)!,
    cid: "cid-one",
    value: {
      name: options.name ?? "One",
      createdAt: "2026-01-01T00:00:00Z",
      startsAt: "2026-02-01T00:00:00Z",
      ...(options.status ? { status: options.status } : {}),
      ...(options.locations ? { locations: options.locations } : {}),
    },
    timeUs: 1,
    indexedAt: 2,
  };
}

const context = {
  env,
  signal: new AbortController().signal,
  attempt: 1,
};

describe("atmo Meilisearch reference consumer", () => {
  it("normalizes stable document IDs, discoverability, and direct geo", () => {
    const current = record({
      locations: [
        {
          $type: "community.lexicon.location.geo",
          latitude: "52.52",
          longitude: "13.405",
        },
      ],
    });
    expect(eventDocumentId(current.uri)).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(eventGeo(current.value)).toEqual({ lat: 52.52, lng: 13.405 });
    expect(eventDocument(current)).toMatchObject({
      id: eventDocumentId(current.uri),
      kind: "event",
      name: "One",
      _geo: { lat: 52.52, lng: 13.405 },
    });
    expect(
      defaultEventDiscoverability(
        record({
          status: "community.lexicon.calendar.event#cancelled",
        }),
      ),
    ).toBe(false);
  });

  it("writes snapshot/tail state, removes hidden and absent rows, and activates idempotently", async () => {
    const fake = new FakeMeili();
    const runtime = createAtmoMeilisearchRuntime({
      fetch: fake.fetch as typeof fetch,
      taskPollMs: 1,
      maxTaskPolls: 3,
    });
    const token = "generation-one";
    const snapshot: SnapshotDeliveryPage = {
      kind: "snapshot",
      consumerId: "search",
      generation: "log-generation",
      bootstrapToken: token,
      collection: "community.lexicon.calendar.event",
      fromUri: null,
      throughUri: record().uri,
      pageId: "page-one",
      records: [record()],
      attempt: 1,
      leaseExpiresAt: Date.now() + 1_000,
    };
    await runtime.changeBootstraps.search!.snapshot(snapshot, context);
    const candidate = candidateIndex("events", token);
    expect(fake.indexes.get(candidate)?.get(eventDocumentId(record().uri))).toMatchObject({
      name: "One",
    });

    const hidden = record({
      uri: "at://did:plc:alice/community.lexicon.calendar.event/hidden",
      status: "community.lexicon.calendar.event#cancelled",
    });
    fake.indexes.get(candidate)!.set(eventDocumentId(hidden.uri), {
      id: eventDocumentId(hidden.uri),
      kind: "event",
    });
    const absentUri = "at://did:plc:alice/community.lexicon.calendar.event/absent";
    fake.indexes.get(candidate)!.set(eventDocumentId(absentUri), {
      id: eventDocumentId(absentUri),
      kind: "event",
    });
    const batch: DeliveryBatch = {
      consumerId: "search",
      cursor: { generation: "log-generation", from: "0", through: "1" },
      changes: [],
      currentRecords: [hidden],
      absentUris: [absentUri],
      destinationToken: token,
    };
    await runtime.deliveries.search!(batch, context);
    expect(fake.indexes.get(candidate)?.has(eventDocumentId(hidden.uri))).toBe(false);
    expect(fake.indexes.get(candidate)?.has(eventDocumentId(absentUri))).toBe(false);

    const activation: ActivationDelivery = {
      kind: "activation",
      consumerId: "search",
      generation: "log-generation",
      bootstrapToken: token,
      target: "1",
      attempt: 1,
      leaseExpiresAt: Date.now() + 1_000,
    };
    await runtime.changeBootstraps.search!.activate(activation, context);
    await runtime.changeBootstraps.search!.activate(activation, context);
    expect(fake.swaps).toBe(1);
    expect(fake.indexes.get("events")?.get("__contrail_generation__")).toMatchObject({
      generation: token,
    });
  });

  it("waits for task success and rejects a failed asynchronous task", async () => {
    const fake = new FakeMeili();
    const runtime = createAtmoMeilisearchRuntime({
      fetch: fake.fetch as typeof fetch,
      taskPollMs: 1,
      maxTaskPolls: 3,
    });
    const token = "generation-failure";
    const snapshot: SnapshotDeliveryPage = {
      kind: "snapshot",
      consumerId: "search",
      generation: "log-generation",
      bootstrapToken: token,
      collection: "community.lexicon.calendar.event",
      fromUri: null,
      throughUri: record().uri,
      pageId: "page-one",
      records: [],
      attempt: 1,
      leaseExpiresAt: Date.now() + 1_000,
    };
    await runtime.changeBootstraps.search!.snapshot(snapshot, context);
    fake.failNext = true;
    await expect(
      runtime.deliveries.search!(
        {
          consumerId: "search",
          cursor: { generation: "log-generation", from: "0", through: "1" },
          changes: [],
          currentRecords: [record()],
          absentUris: [],
          destinationToken: token,
        },
        context,
      ),
    ).rejects.toThrow("fake_failure");
  });
});
