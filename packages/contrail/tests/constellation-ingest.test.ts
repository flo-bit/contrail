import { encode } from "@atcute/cbor";
import { CODEC_DCBOR, create, toString } from "@atcute/cid";
import { create as createTid } from "@atcute/tid";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backfillFollowersFromConstellation,
  createIngestEvent,
  ingestRecords,
  initSchema,
  queryRecords,
  resolveConfig,
  type RecordEvent,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

const EVENT = "com.example.event";
const FOLLOW = "app.bsky.graph.follow";
const SUBJECT = "did:plc:subject";
const FOLLOWER = "did:plc:follower";
const EVENT_URI = `at://${SUBJECT}/${EVENT}/event-one`;
const TID_TIME = 1_700_000_000_000_000;
const FOLLOW_RKEY = createTid(TID_TIME, 0);
const logger = { log() {}, warn() {}, error() {} };

const eventLexicon = {
  lexicon: 1 as const,
  id: EVENT,
  defs: {
    main: {
      type: "record" as const,
      key: "any" as const,
      record: {
        type: "object" as const,
        required: ["name"],
        properties: { name: { type: "string" as const } },
      },
    },
  },
};
const followLexicon = {
  lexicon: 1 as const,
  id: FOLLOW,
  defs: {
    main: {
      type: "record" as const,
      key: "tid" as const,
      record: {
        type: "object" as const,
        required: ["subject", "createdAt"],
        properties: {
          subject: { type: "string" as const, format: "did" as const },
          createdAt: { type: "string" as const, format: "datetime" as const },
        },
      },
    },
  },
};

async function cidFor(record: unknown) {
  return toString(await create(CODEC_DCBOR, encode(record)));
}

async function setup(sinkBatches: RecordEvent[][]) {
  const config = resolveConfig({
    namespace: "com.example",
    profiles: [],
    logger,
    collections: {
      event: { collection: EVENT },
      follow: {
        collection: FOLLOW,
        discover: false,
        subjectField: "subject",
      },
    },
    feeds: {
      network: { follow: "follow", targets: ["event"] },
    },
    validation: { lexicons: [eventLexicon, followLexicon] },
    constellation: {
      url: "https://constellation.example.com",
      userAgent: "contrail-test",
    },
    sinks: [
      {
        async onRecords(records) {
          sinkBatches.push(records);
        },
      },
    ],
  });
  const db = createSqliteDatabase(":memory:");
  await initSchema(db, config);
  for (const did of [SUBJECT, FOLLOWER]) {
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
      )
      .bind(did, null, "https://pds.example.com", 1)
      .run();
  }
  const event = { $type: EVENT, name: "Subject event" };
  await ingestRecords(
    db,
    [
      createIngestEvent({
        uri: EVENT_URI,
        did: SUBJECT,
        collection: EVENT,
        rkey: "event-one",
        operation: "create",
        cid: await cidFor(event),
        value: event,
        timeUs: TID_TIME,
        indexedAt: TID_TIME,
        source: {
          id: "pds-backfill",
          time_us: TID_TIME,
          revision: null,
          cursor: null,
        },
      }),
    ],
    config,
  );
  sinkBatches.length = 0;
  return { config, db };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Constellation enrichment through shared ingestion", () => {
  it("uses normal validation/feed/sink projection and is idempotent", async () => {
    const sinkBatches: RecordEvent[][] = [];
    const { config, db } = await setup(sinkBatches);
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          links: [
            { did: FOLLOWER, rkey: FOLLOW_RKEY },
            {
              uri: `at://${FOLLOWER}/com.example.wrong/${FOLLOW_RKEY}`,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    expect(
      await backfillFollowersFromConstellation(db, config, SUBJECT),
    ).toBe(1);
    expect(
      await backfillFollowersFromConstellation(db, config, SUBJECT),
    ).toBe(0);

    expect(
      (await queryRecords(db, config, { collection: "follow" })).records,
    ).toHaveLength(1);
    expect(
      await db
        .prepare(
          "SELECT source_id, source_revision, source_time_us FROM record_versions WHERE uri = ?",
        )
        .bind(`at://${FOLLOWER}/${FOLLOW}/${FOLLOW_RKEY}`)
        .first(),
    ).toEqual({
      source_id: "constellation",
      source_revision: FOLLOW_RKEY,
      source_time_us: TID_TIME,
    });
    expect(
      await db
        .prepare(
          "SELECT actor, uri FROM feed_items WHERE actor = ? AND uri = ?",
        )
        .bind(FOLLOWER, EVENT_URI)
        .first(),
    ).toEqual({ actor: FOLLOWER, uri: EVENT_URI });
    expect(sinkBatches).toHaveLength(1);
    expect(sinkBatches[0]).toHaveLength(1);
    expect(sinkBatches[0][0]).toMatchObject({
      kind: "created",
      collection: FOLLOW,
    });
  });
});
