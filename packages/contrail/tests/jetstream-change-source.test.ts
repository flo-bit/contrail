import type {
  JetstreamEvent,
  JetstreamSubscriptionOptions,
} from "@atcute/jetstream";
import { describe, expect, it } from "vitest";
import {
  JetstreamChangeSource,
  SourceHistoryExpiredError,
  resolveConfig,
  type SourcePosition,
} from "../src/index";

const COLLECTION = "com.example.event";
const WATERMARK = "app.bsky.feed.post";
const DID = "did:plc:jetstream-source";

function commit(
  timeUs: number,
  collection: string,
  rkey: string,
  operation: "create" | "delete" = "create",
): JetstreamEvent {
  return {
    kind: "commit",
    did: DID,
    time_us: timeUs,
    commit:
      operation === "delete"
        ? {
            operation,
            rev: "3kzfcijpj2z2a",
            collection,
            rkey,
          }
        : {
            operation,
            rev: "3kzfcijpj2z2a",
            collection,
            rkey,
            cid: "bafyreiclp443lav4udnztz7msp6j2wkxwp4m5mns2njm6zq7so4au6druq",
            record: { $type: collection, name: rkey },
          },
  } as JetstreamEvent;
}

function reader(events: JetstreamEvent[]): AsyncIterable<JetstreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function config() {
  return resolveConfig({
    namespace: "com.example",
    profiles: [],
    constellation: false,
    jetstreams: ["wss://jetstream.test"],
    collections: { event: { collection: COLLECTION } },
  });
}

describe("Jetstream change source", () => {
  it("uses real stream events as marks and replays through the exact watermark", async () => {
    const nowUs = Date.now() * 1000;
    const start = nowUs - 20_000;
    const through = start + 10_000;
    const subscriptions: JetstreamSubscriptionOptions[] = [];
    const streams = [
      [commit(start, WATERMARK, "capture")],
      [commit(through, WATERMARK, "target")],
      [
        commit(start - 1, COLLECTION, "overlap"),
        commit(start + 1, COLLECTION, "keep"),
        commit(start + 2, WATERMARK, "ignore"),
        commit(through, COLLECTION, "remove", "delete"),
        commit(through + 1, WATERMARK, "past-target"),
      ],
    ];
    const source = new JetstreamChangeSource(config(), {
      epoch: "test-epoch",
      retentionUs: 60_000_000,
      replayOverlapUs: 100,
      watermarkCollections: [WATERMARK],
      subscriptionFactory(options) {
        subscriptions.push(options);
        return reader(streams.shift() ?? []);
      },
    });

    const capture = await source.mark({ collections: [COLLECTION] });
    const target = await source.mark({ collections: [COLLECTION] });
    const batches = [];
    for await (const batch of source.read({
      collections: [COLLECTION],
      after: capture,
      through: target,
    })) {
      batches.push(batch);
    }

    expect(capture).toEqual({
      source: "jetstream",
      epoch: "test-epoch",
      cursor: String(start),
    });
    expect(target.cursor).toBe(String(through));
    expect(subscriptions).toHaveLength(3);
    expect(subscriptions[0].wantedCollections).toEqual([WATERMARK, COLLECTION]);
    expect(subscriptions[2].cursor).toBe(start - 100);
    expect(batches).toHaveLength(1);
    expect(batches[0].checkpoint).toEqual(target);
    expect(batches[0].caughtUp).toBe(true);
    expect(batches[0].mutations.map((mutation) => mutation.rkey)).toEqual([
      "keep",
      "remove",
    ]);
    expect(batches[0].mutations.map((mutation) => mutation.operation)).toEqual([
      "put",
      "delete",
    ]);
  });

  it("emits empty durable checkpoints for accounted-for watermark traffic", async () => {
    const nowUs = Date.now() * 1000;
    const after: SourcePosition = {
      source: "jetstream",
      epoch: "test-epoch",
      cursor: String(nowUs - 100),
    };
    const through: SourcePosition = {
      ...after,
      cursor: String(nowUs),
    };
    const events = Array.from({ length: 50 }, (_, index) =>
      commit(nowUs - 99 + index, WATERMARK, `watermark-${index}`),
    );
    events.push(commit(nowUs + 1, WATERMARK, "past-target"));
    const source = new JetstreamChangeSource(config(), {
      epoch: "test-epoch",
      retentionUs: 60_000_000,
      watermarkCollections: [WATERMARK],
      subscriptionFactory: () => reader(events),
    });

    const batches = [];
    for await (const batch of source.read({
      collections: [COLLECTION],
      after,
      through,
    })) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ mutations: [], caughtUp: false });
    expect(batches[1]).toEqual({
      mutations: [],
      checkpoint: through,
      caughtUp: true,
    });
  });

  it("blocks replay once the configured source-history guarantee expires", async () => {
    const source = new JetstreamChangeSource(config(), {
      epoch: "test-epoch",
      retentionUs: 1_000,
      subscriptionFactory: () => reader([]),
    });
    const after: SourcePosition = {
      source: "jetstream",
      epoch: "test-epoch",
      cursor: "1",
    };
    const through = { ...after, cursor: "2" };
    const drain = async () => {
      for await (const _batch of source.read({
        collections: [COLLECTION],
        after,
        through,
      })) {
        // Drain the source.
      }
    };

    await expect(drain()).rejects.toBeInstanceOf(SourceHistoryExpiredError);
  });
});
