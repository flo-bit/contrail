import { encode } from "@atcute/cbor";
import { CODEC_DCBOR, create, toString } from "@atcute/cid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backfillUser,
  bindRecordValidationLexicons,
  getIngestDiagnostics,
  initSchema,
  processNotifyUris,
  queryRecords,
  resolveConfig,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { __resetPdsCachesForTests } from "../src/core/client";

const DID = "did:plc:validation-path";
const COLLECTION = "com.example.event";
const URI = `at://${DID}/${COLLECTION}/one`;
const WRONG_CID =
  "bafyreihvzsz6wxhv5idsmsjfbx5jdmfrqx3h4oqw2vvxpwzcdpavqzkp4m";
const record = {
  $type: COLLECTION,
  name: "Valid",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const logger = { log() {}, warn() {}, error() {} };
const config = resolveConfig({
  namespace: "com.example",
  profiles: [],
  logger,
  collections: { event: { collection: COLLECTION, validate: true } },
});
bindRecordValidationLexicons(config, [
  {
    lexicon: 1,
    id: COLLECTION,
    defs: {
      main: {
        type: "record",
        key: "any",
        record: {
          type: "object",
          required: ["name", "createdAt"],
          properties: {
            name: { type: "string" },
            createdAt: { type: "string", format: "datetime" },
          },
        },
      },
    },
  },
]);

async function setup() {
  const db = createSqliteDatabase(":memory:");
  await initSchema(db, config);
  await db
    .prepare(
      "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)",
    )
    .bind(DID, "validation.test", "https://pds.example.com", Date.now())
    .run();
  return db;
}

async function validCid() {
  return toString(await create(CODEC_DCBOR, encode(record)));
}

beforeEach(() => {
  __resetPdsCachesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetPdsCachesForTests();
});

describe("validation across acquisition paths", () => {
  it.each([
    ["valid", true],
    ["mismatched", false],
  ])("applies the same CID policy to PDS backfill: %s", async (_name, valid) => {
    const db = await setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            records: [
              {
                uri: URI,
                cid: valid ? await validCid() : WRONG_CID,
                value: record,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const accepted = await backfillUser(
      db,
      DID,
      COLLECTION,
      Infinity,
      config,
      { maxRetries: 0 },
    );

    expect(accepted).toBe(valid ? 1 : 0);
    expect(
      (await queryRecords(db, config, { collection: "event" })).records,
    ).toHaveLength(valid ? 1 : 0);
    expect(
      (await getIngestDiagnostics(db)).find(
        ({ category }) => category === "cid_mismatch",
      )?.total,
    ).toBe(valid ? 0 : 1);
  });

  it.each([
    ["valid", true],
    ["mismatched", false],
  ])("applies the same CID policy to notify/PDS repair: %s", async (_name, valid) => {
    const db = await setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            uri: URI,
            cid: valid ? await validCid() : WRONG_CID,
            value: record,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await processNotifyUris(db, config, [URI]);

    expect(result.indexed).toBe(valid ? 1 : 0);
    expect(
      (await queryRecords(db, config, { collection: "event" })).records,
    ).toHaveLength(valid ? 1 : 0);
    expect(
      (await getIngestDiagnostics(db)).find(
        ({ category }) => category === "cid_mismatch",
      )?.total,
    ).toBe(valid ? 0 : 1);
  });
});
