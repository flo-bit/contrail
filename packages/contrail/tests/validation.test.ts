import { encode } from "@atcute/cbor";
import { CODEC_DCBOR, create, toString } from "@atcute/cid";
import { describe, expect, it } from "vitest";
import {
  Contrail,
  bindRecordValidationLexicons,
  createIngestEvent,
  getIngestDiagnostics,
  ingestRecords,
  initSchema,
  prepareRecordValidation,
  queryRecords,
  resolveConfig,
  saveCursorStatement,
  type ContrailConfig,
  type Database,
} from "../src/index";
import { createSqliteDatabase } from "../src/adapters/sqlite";

const COLLECTION = "com.example.event";
const LEXICON = {
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
          name: { type: "string", maxLength: 10 },
          createdAt: { type: "string", format: "datetime" },
        },
      },
    },
  },
} as const;
const logger = { log() {}, warn() {}, error() {} };

function validatedConfig(overrides: Partial<ContrailConfig> = {}) {
  const config = resolveConfig({
    namespace: "com.example",
    profiles: [],
    logger,
    collections: {
      event: { collection: COLLECTION, validate: true },
    },
    validation: overrides.validation,
    ...overrides,
  });
  bindRecordValidationLexicons(config, [LEXICON]);
  return config;
}

async function setup(config = validatedConfig()): Promise<Database> {
  const db = createSqliteDatabase(":memory:");
  await initSchema(db, config);
  return db;
}

async function cidFor(record: unknown): Promise<string> {
  return toString(await create(CODEC_DCBOR, encode(record)));
}

async function event(options: {
  record?: Record<string, unknown>;
  cid?: string | null;
  rkey?: string;
  sourceId?: string;
}) {
  const record = options.record ?? {
    $type: COLLECTION,
    name: "valid",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const cid =
    options.cid === undefined ? await cidFor(record) : options.cid;
  return createIngestEvent({
    did: "did:plc:alice",
    collection: COLLECTION,
    rkey: options.rkey ?? "one",
    operation: "create",
    cid,
    value: record,
    timeUs: 100,
    indexedAt: 200,
    source: {
      id: options.sourceId ?? "jetstream",
      time_us: 100,
      revision: "1",
      cursor: "100",
    },
  });
}

describe("runtime record validation", () => {
  it.each([undefined, false])(
    "does not validate a collection when validate is %s",
    async (validate) => {
      const config = validatedConfig({
        collections: {
          event: { collection: COLLECTION, validate },
        },
      });
      const db = await setup(config);
      const result = await ingestRecords(
        db,
        [
          await event({
            record: {
              $type: COLLECTION,
              name: "far too long",
              createdAt: "not-a-date",
            },
          }),
        ],
        config,
      );

      expect(result.accepted).toHaveLength(1);
      expect(result.dropped.lexiconValidation).toBe(0);
    },
  );

  it("admits a valid Lexicon record with its canonical CID", async () => {
    const config = validatedConfig();
    const db = await setup(config);
    const result = await ingestRecords(db, [await event({})], config);

    expect(result.accepted).toHaveLength(1);
    expect(
      (await queryRecords(db, config, { collection: "event" })).records,
    ).toHaveLength(1);
  });

  it.each([
    [
      "wrong $type",
      {
        $type: "com.example.wrong",
        name: "valid",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "one",
    ],
    [
      "missing required field",
      { $type: COLLECTION, createdAt: "2026-01-01T00:00:00.000Z" },
      "one",
    ],
    [
      "maximum length",
      {
        $type: COLLECTION,
        name: "far too long",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "one",
    ],
    [
      "datetime syntax",
      { $type: COLLECTION, name: "valid", createdAt: "yesterday-ish" },
      "one",
    ],
    [
      "record key syntax",
      {
        $type: COLLECTION,
        name: "valid",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "bad key",
    ],
  ])("rejects invalid Lexicon input: %s", async (_name, record, rkey) => {
    const config = validatedConfig();
    const db = await setup(config);
    const result = await ingestRecords(
      db,
      [await event({ record, rkey })],
      config,
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.dropped.lexiconValidation).toBe(1);
    expect(
      (await queryRecords(db, config, { collection: "event" })).records,
    ).toHaveLength(0);
  });

  it("rejects a record whose claimed CID does not match canonical DAG-CBOR", async () => {
    const config = validatedConfig();
    const db = await setup(config);
    const result = await ingestRecords(
      db,
      [
        await event({
          cid: "bafyreihvzsz6wxhv5idsmsjfbx5jdmfrqx3h4oqw2vvxpwzcdpavqzkp4m",
        }),
      ],
      config,
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.dropped.cidMismatch).toBe(1);
  });

  it("requires authoritative sources to provide a CID", async () => {
    const config = validatedConfig();
    const db = await setup(config);
    const result = await ingestRecords(
      db,
      [await event({ cid: null, sourceId: "pds-backfill" })],
      config,
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.dropped.missingCid).toBe(1);
  });

  it("allows configured local/synthetic sources to omit a CID", async () => {
    const config = validatedConfig();
    const db = await setup(config);
    const result = await ingestRecords(
      db,
      [await event({ cid: null, sourceId: "local" })],
      config,
    );

    expect(result.accepted).toHaveLength(1);
  });

  it("caches one validator set per validation config", () => {
    const config = validatedConfig();
    expect(prepareRecordValidation(config)).toBe(prepareRecordValidation(config));
  });

  it("fails configuration early when a collection Lexicon is missing", () => {
    expect(
      () =>
        new Contrail({
          namespace: "com.example",
          profiles: [],
          collections: {
            event: { collection: COLLECTION, validate: true },
          },
          lexicons: [],
        }),
    ).toThrow(`missing validation Lexicon document: ${COLLECTION}`);
  });

  it("rolls diagnostics and a source cursor back together", async () => {
    const config = validatedConfig();
    const db = await setup(config);
    await db.prepare("CREATE TABLE diagnostic_failure (value TEXT UNIQUE)").run();
    await db
      .prepare("INSERT INTO diagnostic_failure (value) VALUES ('duplicate')")
      .run();

    await expect(
      ingestRecords(
        db,
        [
          await event({
            record: {
              $type: COLLECTION,
              name: "far too long",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        ],
        config,
        {
          trailingStatements: [
            saveCursorStatement(db, 100),
            db.prepare(
              "INSERT INTO diagnostic_failure (value) VALUES ('duplicate')",
            ),
          ],
        },
      ),
    ).rejects.toThrow();

    expect(
      (await getIngestDiagnostics(db)).find(
        ({ category }) => category === "lexicon_validation",
      )?.total,
    ).toBe(0);
    expect(await db.prepare("SELECT time_us FROM cursor").first()).toBeNull();
  });

  it("persists bounded aggregate diagnostics without record identifiers", async () => {
    const config = validatedConfig();
    const db = await setup(config);
    await ingestRecords(
      db,
      [
        await event({
          record: {
            $type: COLLECTION,
            name: "far too long",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        await event({ cid: null, sourceId: "jetstream" }),
      ],
      config,
    );

    const diagnostics = await getIngestDiagnostics(db);
    expect(
      diagnostics.find(({ category }) => category === "lexicon_validation")
        ?.total,
    ).toBe(1);
    expect(
      diagnostics.find(({ category }) => category === "missing_cid")?.total,
    ).toBe(1);
    const columns = await db
      .prepare("PRAGMA table_info(ingest_diagnostics)")
      .all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual([
      "category",
      "total",
      "last_seen_at",
    ]);
  });
});
