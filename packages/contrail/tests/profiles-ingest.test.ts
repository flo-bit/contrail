import { encode } from "@atcute/cbor";
import { CODEC_DCBOR, create, toString } from "@atcute/cid";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindRecordValidationLexicons,
  createIngestEvent,
  ingestRecords,
  initSchema,
  queryRecords,
  resolveConfig,
  resolveProfiles,
  type Database,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

const DID = "did:plc:profile-test";
const PROFILE_A = "com.example.profileA";
const PROFILE_B = "com.example.profileB";
const logger = { log() {}, warn() {}, error() {} };

// Node 22's built-in SQLite does not include FTS5, while D1 and newer Node
// builds do. Keep this shared-ingestion test meaningful on both runtimes and
// exercise the FTS projection whenever the database supports it.
let hasFts = false;
try {
  const testDb = createSqliteDatabase(":memory:");
  await testDb
    .prepare("CREATE VIRTUAL TABLE __profile_fts_test USING fts5(content)")
    .run();
  hasFts = true;
} catch {}

function profileLexicon(id: string) {
  return {
    lexicon: 1 as const,
    id,
    defs: {
      main: {
        type: "record" as const,
        key: "literal:self" as const,
        record: {
          type: "object" as const,
          required: ["displayName"],
          properties: {
            displayName: { type: "string" as const, maxLength: 100 },
          },
        },
      },
    },
  };
}

async function cidFor(record: unknown) {
  return toString(await create(CODEC_DCBOR, encode(record)));
}

async function setup(options?: { rejectB?: boolean }) {
  const config = resolveConfig({
    namespace: "com.example",
    logger,
    profiles: [
      { collection: PROFILE_A, shortName: "profileA" },
      { collection: PROFILE_B, shortName: "profileB" },
    ],
    collections: {
      profileA: { collection: PROFILE_A, validate: true },
      profileB: {
        collection: PROFILE_B,
        searchable: hasFts ? ["displayName"] : false,
        validate: true,
        recordFilter: options?.rejectB
          ? (record) => record.displayName !== "Rejected"
          : undefined,
      },
    },
  });
  bindRecordValidationLexicons(config, [
    profileLexicon(PROFILE_A),
    profileLexicon(PROFILE_B),
  ]);
  const db = createSqliteDatabase(":memory:");
  await initSchema(db, config);
  await db
    .prepare(
      "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
    )
    .bind(DID, "profile.test", "https://pds.example.com", Date.now())
    .run();
  return { config, db };
}

async function seedProfileA(db: Database, config: ReturnType<typeof resolveConfig>) {
  const record = { $type: PROFILE_A, displayName: "Cached A" };
  await ingestRecords(
    db,
    [
      createIngestEvent({
        did: DID,
        collection: PROFILE_A,
        rkey: "self",
        operation: "create",
        cid: await cidFor(record),
        value: record,
        timeUs: 100,
        indexedAt: 100,
        source: {
          id: "pds-backfill",
          time_us: 100,
          revision: null,
          cursor: null,
        },
      }),
    ],
    config,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("profile enrichment through shared ingestion", () => {
  it("checks each profile collection and applies validation, optional FTS, and source metadata", async () => {
    const { config, db } = await setup();
    await seedProfileA(db, config);
    const profileB = { $type: PROFILE_B, displayName: "Fetched B" };
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.searchParams.get("collection")).toBe(PROFILE_B);
      return new Response(
        JSON.stringify({
          uri: `at://${DID}/${PROFILE_B}/self`,
          cid: await cidFor(profileB),
          value: profileB,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const profiles = await resolveProfiles(db, config, [DID]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(profiles[DID].map((entry) => entry.collection).sort()).toEqual([
      PROFILE_A,
      PROFILE_B,
    ]);
    expect(
      await db
        .prepare(
          "SELECT source_id, indexed_at FROM record_versions WHERE uri = ?",
        )
        .bind(`at://${DID}/${PROFILE_B}/self`)
        .first(),
    ).toMatchObject({
      source_id: "pds-profile",
      indexed_at: expect.any(Number),
    });
    expect(
      (
        await queryRecords(db, config, {
          collection: "profileB",
          ...(hasFts ? { search: "Fetched" } : {}),
        })
      ).records,
    ).toHaveLength(1);
  });

  it("does not return or persist a fetched profile rejected by normal admission", async () => {
    const { config, db } = await setup({ rejectB: true });
    await seedProfileA(db, config);
    const rejected = { $type: PROFILE_B, displayName: "Rejected" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            uri: `at://${DID}/${PROFILE_B}/self`,
            cid: await cidFor(rejected),
            value: rejected,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const profiles = await resolveProfiles(db, config, [DID]);

    expect(profiles[DID].map((entry) => entry.collection)).toEqual([PROFILE_A]);
    expect(
      (await queryRecords(db, config, { collection: "profileB" })).records,
    ).toHaveLength(0);
  });
});
