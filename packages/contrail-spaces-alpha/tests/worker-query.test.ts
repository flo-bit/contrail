import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { createServiceJwt } from "@atcute/xrpc-server/auth";
import {
  bindRecordValidationLexicons,
  createIngestEvent,
  createIsolatedProjection,
  ingestRecords,
  resolveConfig,
} from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { createSpacesWorker } from "../src/worker";
import { ensureSpaceWatch, initSpacesStorage } from "../src/storage";
import { spaceProjectionKey } from "../src/uri";

const issuer = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const audience = "did:web:spaces.atmo.garden#spaces";
const space = `${"at://did:plc:alice"}/space/garden.atmo.circle/self`;
const collection = "garden.atmo.circle.note";
let keypair: Secp256k1PrivateKeyExportable;

beforeAll(async () => {
  keypair = await Secp256k1PrivateKeyExportable.createKeypair();
});

const projection = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: {
    note: { collection, validate: true, searchable: ["text"] },
  },
  validation: { verifyCid: false },
});

const lexicons = [{
  lexicon: 1,
  id: collection,
  defs: {
    main: {
      type: "record",
      key: "tid",
      record: {
        type: "object",
        required: ["text", "createdAt"],
        properties: {
          text: { type: "string", maxLength: 2000 },
          createdAt: { type: "string", format: "datetime" },
        },
      },
    },
  },
}] as const;

async function token(method: string) {
  return createServiceJwt({
    keypair,
    issuer: issuer as never,
    audience: audience as never,
    lxm: method as never,
  });
}

function context(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

describe("Spaces Worker private query boundary", () => {
  it("requires a method token and returns only the named Space", async () => {
    const db = createSqliteDatabase(":memory:");
    bindRecordValidationLexicons(projection, lexicons);
    await initSpacesStorage(db, projection);
    await ensureSpaceWatch(db, { spaceUri: space });
    const event = createIngestEvent({
      uri: `${space}/${issuer}/${collection}/3h4oqw2vvxpwz`,
      did: issuer,
      collection,
      rkey: "3h4oqw2vvxpwz",
      operation: "create",
      cid: "bafy-test",
      value: {
        $type: collection,
        text: "private hello",
        createdAt: "2026-08-21T00:00:00Z",
      },
      timeUs: 1_000_000,
      source: { id: "space-test", revision: "1", time_us: 1_000_000 },
    });
    await ingestRecords(db, [event], projection, {
      projection: createIsolatedProjection({
        scope: { kind: "isolated", key: spaceProjectionKey(space, 1) },
        partition: issuer,
        generation: 1,
        activate: true,
      }),
      skipDiagnostics: true,
    });

    const worker = createSpacesWorker({
      projection,
      lexicons,
      service: {
        endpoint: "https://spaces.atmo.garden",
        audience,
        resolver: {
          async resolve(did) {
            return {
              "@context": [],
              id: did,
              verificationMethod: [{
                id: `${did}#atproto`,
                type: "Multikey",
                controller: did,
                publicKeyMultibase: await keypair.exportPublicKey("multikey"),
              }],
            };
          },
        },
      },
      spaceTypes: {
        "garden.atmo.circle": { collections: [collection], skey: "self" },
      },
      authorization: { authorize: () => true },
    });
    const method = "garden.atmo.circle.note.listSpaceRecords";
    const url = `https://spaces.atmo.garden/xrpc/${method}?space=${encodeURIComponent(space)}`;
    const queued: unknown[] = [];
    const env = {
      DB: db,
      SPACES_CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      SPACES_QUEUE: { send: async (message: unknown) => { queued.push(message); } },
    } as never;

    const anonymous = await worker.fetch!(new Request(url) as never, env, context());
    expect(anonymous.status).toBe(401);

    const request = new Request(url, {
      headers: { authorization: `Bearer ${await token(method)}` },
    });
    const response = await worker.fetch!(request as never, env, context());
    expect(response.status).toBe(200);
    const body = await response.json() as { records: Array<{ value: { text: string } }> };
    expect(body.records.map((record) => record.value.text)).toEqual(["private hello"]);

    const wrongMethod = new Request(url, {
      headers: {
        authorization: `Bearer ${await token("garden.atmo.circle.syncSpace")}`,
      },
    });
    expect((await worker.fetch!(wrongMethod as never, env, context())).status).toBe(401);

    const syncMethod = "garden.atmo.circle.syncSpace";
    const targetedSync = new Request(`https://spaces.atmo.garden/xrpc/${syncMethod}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token(syncMethod)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ space, repo: "did:plc:unadvertised" }),
    });
    expect((await worker.fetch!(targetedSync as never, env, context())).status).toBe(202);
    expect(queued).toEqual([{
      kind: "reconcile",
      space,
      preferredRepo: "did:plc:unadvertised",
    }]);
  });
});
