import { describe, expect, it } from "vitest";
import {
  AlluviumSnapshotSource,
  createAlluviumBootstrapSources,
  type AlluviumCollectionManifest,
} from "../src/adapters/alluvium";
import { resolveConfig, type SourcePosition } from "../src/index";

const EVENT = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";
const DID = "did:plc:alluviumsource";
const ENDPOINT = "https://alluvium.test";
const SOURCE_URL = "wss://jetstream.test";
const SOURCE = {
  id: "jetstream-test",
  epoch: "test-epoch",
  url: SOURCE_URL,
};

interface FixtureObject {
  bytes: Uint8Array;
  checksum: string;
  lines: number;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixtureObject(values: unknown[]): Promise<FixtureObject> {
  const source = new TextEncoder().encode(
    values.map((value) => `${JSON.stringify(value)}\n`).join(""),
  );
  const body = new Blob([source]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { bytes, checksum: `sha256:${hex(digest)}`, lines: values.length };
}

function baseRecord(collection: string, rkey: string, value: string) {
  return {
    v: 1,
    uri: `at://${DID}/${collection}/${rkey}`,
    did: DID,
    collection,
    rkey,
    cid: `bafy-${rkey}-${value}`,
    record: { $type: collection, value },
  };
}

function putEvent(
  collection: string,
  rkey: string,
  value: string,
  run: number,
  timeUs: number,
) {
  return {
    v: 1,
    run,
    timeUs,
    source: SOURCE.id,
    op: "put",
    uri: `at://${DID}/${collection}/${rkey}`,
    did: DID,
    collection,
    rkey,
    rev: `rev-${run}`,
    cid: `bafy-${rkey}-${value}`,
    record: { $type: collection, value },
  };
}

function deleteEvent(collection: string, rkey: string, run: number, timeUs: number) {
  return {
    v: 1,
    run,
    timeUs,
    source: SOURCE.id,
    op: "delete",
    uri: `at://${DID}/${collection}/${rkey}`,
    did: DID,
    collection,
    rkey,
    rev: `rev-${run}`,
  };
}

function manifest(options: {
  collection: string;
  base: FixtureObject;
  tail: FixtureObject;
  baseTimeUs: number;
  archiveTimeUs: number;
  omitted?: number;
  knownGaps?: number;
}): AlluviumCollectionManifest {
  const { collection, base, tail, baseTimeUs, archiveTimeUs } = options;
  return {
    format: "alluvium.collection",
    version: 1,
    collection,
    state: "active",
    source: {
      id: SOURCE.id,
      protocol: "jetstream-v1",
      url: SOURCE.url,
      archivedThroughTimeUs: archiveTimeUs,
    },
    semantics: {
      operations: ["put", "delete"],
      accountDeletion: false,
      repositorySync: false,
      physicalPayloadDeletion: false,
    },
    coverage: {
      captureFromRun: 1,
      captureFromTimeUs: baseTimeUs - 1,
      capturedThroughRun: 3,
      capturedThroughTimeUs: archiveTimeUs,
      knownGaps: options.knownGaps ?? 0,
      historicalBootstrap: "current-records-from-pds",
    },
    base: {
      generation: 1,
      throughRun: 1,
      throughTimeUs: baseTimeUs,
      url: `/objects/${collection}-base`,
      checksum: base.checksum,
      records: base.lines,
      compressedBytes: base.bytes.byteLength,
      seedKind: "backfill",
      historicalCoverage: {
        scope: "configured-relays",
        status: options.omitted ? "incomplete" : "complete",
        accountsDiscovered: 2,
        accountsIncluded: 2 - (options.omitted ?? 0),
        accountsOmitted: options.omitted ?? 0,
        report: null,
      },
      parts: [
        {
          part: 0,
          url: `/objects/${collection}-base`,
          checksum: base.checksum,
          records: base.lines,
          compressedBytes: base.bytes.byteLength,
        },
      ],
    },
    tail: [
      {
        run: 2,
        firstRun: 2,
        lastRun: 2,
        level: "hour",
        part: 0,
        firstTimeUs: baseTimeUs + 1,
        lastTimeUs: archiveTimeUs - 1,
        url: `/objects/${collection}-tail`,
        checksum: tail.checksum,
        events: tail.lines,
        compressedBytes: tail.bytes.byteLength,
      },
    ],
  };
}

function transport(options: {
  manifests: AlluviumCollectionManifest[];
  objects: Map<string, FixtureObject>;
}): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    const collectionMatch = url.pathname.match(/^\/v1\/collections\/(.+)\/manifest$/);
    if (collectionMatch) {
      const collection = decodeURIComponent(collectionMatch[1]!);
      const value = options.manifests.find((item) => item.collection === collection);
      return value ? Response.json(value) : Response.json({ error: "UnknownCollection" }, { status: 404 });
    }
    const value = options.objects.get(url.pathname);
    return value
      ? new Response(value.bytes as unknown as BodyInit, {
          headers: { "Content-Length": String(value.bytes.byteLength) },
        })
      : new Response(null, { status: 404 });
  };
}

function config() {
  return resolveConfig({
    namespace: "com.example",
    profiles: [],
    constellation: false,
    collections: {
      event: { collection: EVENT },
      rsvp: { collection: RSVP },
    },
  });
}

describe("Alluvium bootstrap source", () => {
  it("pins matching manifests, streams verified bases, and stops at the archive boundary", async () => {
    const nowUs = Date.now() * 1_000;
    const baseTimeUs = nowUs - 20_000;
    const archiveTimeUs = nowUs - 10_000;
    const eventBase = await fixtureObject([
      baseRecord(EVENT, "event", "old"),
      baseRecord(EVENT, "remove", "old"),
    ]);
    const rsvpBase = await fixtureObject([baseRecord(RSVP, "rsvp", "old")]);
    const eventTail = await fixtureObject([
      putEvent(EVENT, "event", "archive", 2, baseTimeUs + 2),
      deleteEvent(EVENT, "remove", 2, baseTimeUs + 3),
    ]);
    const rsvpTail = await fixtureObject([
      putEvent(RSVP, "rsvp", "archive", 2, baseTimeUs + 1),
    ]);
    const manifests = [
      manifest({ collection: EVENT, base: eventBase, tail: eventTail, baseTimeUs, archiveTimeUs }),
      manifest({
        collection: RSVP,
        base: rsvpBase,
        tail: rsvpTail,
        baseTimeUs,
        archiveTimeUs,
        omitted: 1,
      }),
    ];
    const objects = new Map<string, FixtureObject>([
      [`/objects/${EVENT}-base`, eventBase],
      [`/objects/${EVENT}-tail`, eventTail],
      [`/objects/${RSVP}-base`, rsvpBase],
      [`/objects/${RSVP}-tail`, rsvpTail],
    ]);
    const source = createAlluviumBootstrapSources(config(), {
      endpoint: ENDPOINT,
      source: SOURCE,
      fetch: transport({ manifests, objects }),
      transport: { batchSize: 1, maxAttempts: 1 },
      jetstream: { retentionUs: 60_000_000 },
    });

    const snapshot = await source.snapshotSource.prepare({ collections: [RSVP, EVENT] });
    expect(snapshot.through).toEqual({
      source: SOURCE.id,
      epoch: SOURCE.epoch,
      cursor: String(baseTimeUs),
    });
    expect(snapshot.collections).toEqual({
      [EVENT]: { state: "complete" },
      [RSVP]: {
        state: "partial",
        reason: "Alluvium historical coverage omitted accounts",
        unresolved: 1,
      },
    });

    const snapshotBatches = [];
    for await (const batch of source.snapshotSource.read({ snapshot })) {
      snapshotBatches.push(batch);
    }
    expect(snapshotBatches.filter((batch) => batch.done)).toHaveLength(1);
    expect(snapshotBatches.flatMap((batch) => batch.records).map((record) => record.rkey)).toEqual([
      "event",
      "remove",
      "rsvp",
    ]);

    const through = await source.changeSource.mark({
      collections: [EVENT, RSVP],
      snapshot,
    });
    expect(through).toEqual({
      source: SOURCE.id,
      epoch: SOURCE.epoch,
      cursor: String(archiveTimeUs),
    } satisfies SourcePosition);
    const changeBatches = [];
    for await (const batch of source.changeSource.read({
      collections: [EVENT, RSVP],
      snapshot,
      after: snapshot.through!,
      through,
    })) {
      changeBatches.push(batch);
    }
    const mutations = changeBatches.flatMap((batch) => batch.mutations);
    expect(mutations.map((mutation) => [mutation.collection, mutation.rkey, mutation.operation])).toEqual([
      [RSVP, "rsvp", "put"],
      [EVENT, "event", "put"],
      [EVENT, "remove", "delete"],
    ]);
    expect(changeBatches).toContainEqual({
      mutations: [],
      checkpoint: {
        source: SOURCE.id,
        epoch: SOURCE.epoch,
        cursor: String(archiveTimeUs),
      },
      caughtUp: true,
    });
    expect(changeBatches.at(-1)).toMatchObject({ checkpoint: through, caughtUp: true });
  });

  it("rejects known gaps and selected bases at different boundaries", async () => {
    const nowUs = Date.now() * 1_000;
    const base = await fixtureObject([baseRecord(EVENT, "one", "base")]);
    const tail = await fixtureObject([]);
    const event = manifest({
      collection: EVENT,
      base,
      tail,
      baseTimeUs: nowUs - 20_000,
      archiveTimeUs: nowUs - 10_000,
      knownGaps: 1,
    });
    const gapSource = new AlluviumSnapshotSource({
      endpoint: ENDPOINT,
      source: SOURCE,
      fetch: transport({ manifests: [event], objects: new Map() }),
      jetstream: { retentionUs: 60_000_000 },
    });
    await expect(gapSource.prepare({ collections: [EVENT] })).rejects.toThrow("known capture gaps");

    event.coverage.knownGaps = 0;
    const rsvp = manifest({
      collection: RSVP,
      base: await fixtureObject([baseRecord(RSVP, "one", "base")]),
      tail,
      baseTimeUs: nowUs - 19_000,
      archiveTimeUs: nowUs - 10_000,
    });
    const mismatched = new AlluviumSnapshotSource({
      endpoint: ENDPOINT,
      source: SOURCE,
      fetch: transport({ manifests: [event, rsvp], objects: new Map() }),
      jetstream: { retentionUs: 60_000_000 },
    });
    await expect(mismatched.prepare({ collections: [EVENT, RSVP] })).rejects.toThrow(
      "one shared boundary",
    );
  });

  it("verifies compressed bytes before emitting snapshot records", async () => {
    const nowUs = Date.now() * 1_000;
    const base = await fixtureObject([baseRecord(EVENT, "one", "base")]);
    const tail = await fixtureObject([]);
    const event = manifest({
      collection: EVENT,
      base,
      tail,
      baseTimeUs: nowUs - 20_000,
      archiveTimeUs: nowUs - 10_000,
    });
    event.base.parts[0]!.checksum = `sha256:${"0".repeat(64)}`;
    const source = new AlluviumSnapshotSource({
      endpoint: ENDPOINT,
      source: SOURCE,
      fetch: transport({
        manifests: [event],
        objects: new Map([[`/objects/${EVENT}-base`, base]]),
      }),
      transport: { maxAttempts: 1 },
      jetstream: { retentionUs: 60_000_000 },
    });
    const snapshot = await source.prepare({ collections: [EVENT] });
    const drain = async () => {
      for await (const _batch of source.read({ snapshot })) {
        // Drain the verified source.
      }
    };
    await expect(drain()).rejects.toThrow("checksum");
  });
});
