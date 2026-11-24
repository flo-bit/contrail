import { createSqliteDatabase } from "../src/adapters/sqlite";
import { createPgliteDatabase } from "./pglite";
import type { Database, IngestEvent, ResolvedContrailConfig } from "../src/index";
import { resolveConfig } from "../src/index";
import { initSchema } from "../src/index";
import { ingestRecords as coreIngestRecords } from "../src/index";
import { type ExistingRecordInfo } from "../src/core/db/records";

/** `CONTRAIL_TEST_DIALECT=postgres` runs suites on in-process PostgreSQL. */
export const TEST_POSTGRES = process.env.CONTRAIL_TEST_DIALECT === "postgres";

export function createTestDb(): Database {
  if (TEST_POSTGRES) return createPgliteDatabase();
  return createSqliteDatabase(":memory:");
}

export const TEST_CONFIG: ResolvedContrailConfig = resolveConfig({
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: {
        mode: {},
        name: {},
        startsAt: { type: "range" },
      },
      relations: {
        rsvps: {
          collection: "rsvp",
          groupBy: "status",
          groups: {
            interested: "community.lexicon.calendar.rsvp#interested",
            going: "community.lexicon.calendar.rsvp#going",
            notgoing: "community.lexicon.calendar.rsvp#notgoing",
          },
        },
      },
    },
    rsvp: {
      collection: "community.lexicon.calendar.rsvp",
      references: {
        event: {
          collection: "event",
          field: "subject.uri",
        },
      },
    },
  },
});

export async function createTestDbWithSchema(): Promise<Database> {
  const db = createTestDb();
  await initSchema(db, TEST_CONFIG);
  return db;
}

/** Ingest records with TEST_CONFIG baked in. */
export function ingestRecords(
  db: Database,
  events: IngestEvent[],
  options?: {
    skipReplayDetection?: boolean;
    skipFeedFanout?: boolean;
    skipDerivedProjections?: boolean;
    existing?: Map<string, ExistingRecordInfo>;
  }
): Promise<void> {
  return coreIngestRecords(db, events, TEST_CONFIG, options).then(() => undefined);
}

export function makeEvent(overrides: Partial<{
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  cid: string | null;
  record: any;
  time_us: number;
  indexed_at: number;
  operation: "create" | "update" | "delete";
}> = {}) {
  return {
    uri: overrides.uri ?? "at://did:plc:test/community.lexicon.calendar.event/abc",
    did: overrides.did ?? "did:plc:test",
    collection: overrides.collection ?? "community.lexicon.calendar.event",
    rkey: overrides.rkey ?? "abc",
    cid: overrides.cid ?? "bafyabc",
    record: overrides.record !== undefined
      ? (typeof overrides.record === "string" ? overrides.record : JSON.stringify(overrides.record))
      : JSON.stringify({ name: "Test Event", startsAt: "2026-04-01T10:00:00Z", mode: "online" }),
    time_us: overrides.time_us ?? 1000000,
    indexed_at: overrides.indexed_at ?? Date.now(),
    operation: overrides.operation ?? ("create" as const),
  };
}

/** The feed-prune case each ingest entry point is tested against. Alice follows
 *  Bob and her feed in `collection` sits at its cap of 2; Dave follows no one and
 *  his feed is 3 over. A new item from Bob grows only Alice's feed, so after it
 *  is ingested, a grown-feed prune leaves her at 2 with Bob's item kept and Dave
 *  untouched at 5. Callers configure `collection` as a feed target with
 *  `maxItems: 2`, and mark the recovery pass as done so it can't trim feeds
 *  itself. */
export const GROWN_FEED = {
  author: "did:plc:bob",
  follower: "did:plc:alice",
  bystander: "did:plc:dave",
} as const;

/** Insert a follow row directly, without ingestion. */
export async function seedFollow(db: Database, follower: string, subject: string): Promise<void> {
  const rkey = subject.replace(/\W/g, "");
  await db
    .prepare(
      "INSERT INTO records_follow (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      `at://${follower}/app.bsky.graph.follow/${rkey}`,
      follower,
      rkey,
      "bafyfollow",
      JSON.stringify({ subject }),
      1000,
      1000
    )
    .run();
}

export async function seedGrownFeed(db: Database, collection: string): Promise<void> {
  const { author, follower, bystander } = GROWN_FEED;
  await seedFollow(db, follower, author);
  const feed: Array<[string, number]> = [
    [follower, 2],
    [bystander, 5],
  ];
  for (const [actor, count] of feed) {
    for (let i = 0; i < count; i++) {
      await db
        .prepare("INSERT INTO feed_items (actor, uri, collection, time_us) VALUES (?, ?, ?, ?)")
        .bind(actor, `at://did:plc:old/${collection}/${actor}-${i}`, collection, 1000 + i)
        .run();
    }
  }
}

/** An actor's feed URIs in `collection`, newest first. */
export async function feedUris(db: Database, actor: string, collection: string): Promise<string[]> {
  const res = await db
    .prepare("SELECT uri FROM feed_items WHERE actor = ? AND collection = ? ORDER BY time_us DESC")
    .bind(actor, collection)
    .all<{ uri: string }>();
  return (res.results ?? []).map((r) => r.uri);
}
