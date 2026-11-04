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
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSpacesWorker } from "../src/worker";
import {
  ensureSpaceWatch,
  initSpacesStorage,
  saveAccessLease,
} from "../src/storage";
import { spaceProjectionKey } from "../src/uri";

const issuer = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const audience = "did:web:spaces.atmo.garden#spaces";
const space = `at://${issuer}/space/garden.atmo.circle/self`;
const collection = "garden.atmo.circle.note";
let keypair: Secp256k1PrivateKeyExportable;

beforeAll(async () => {
  keypair = await Secp256k1PrivateKeyExportable.createKeypair();
});

const projection = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: {
    note: { collection, validate: true },
  },
  validation: { verifyCid: false },
});

const lexicons = [
  {
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
  },
] as const;

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
  it.each([false, true])(
    "reauthorizes indexed Spaces and paginates past denied leases (custom lookup=%s)",
    async (customLookup) => {
      const db = createSqliteDatabase(":memory:");
      await initSpacesStorage(db, projection);
      const userDid = "did:plc:bob";
      const uri = (key: string) => space.replace(/self$/, key);
      const denied = ["00", "01", "02", "03"].map(uri);
      const allowed = ["A", "Z", "a", "z"].map(uri);
      const custom = uri("B");
      for (const spaceUri of [...denied, ...allowed, custom]) {
        await ensureSpaceWatch(db, { spaceUri });
        if (spaceUri !== custom) {
          await saveAccessLease(db, {
            userDid,
            spaceUri,
            generation: 1,
            expiresAt: Date.now() + 60_000,
          });
        }
      }
      let permit = true;
      const authorize = vi.fn(
        (input: {
          userDid: string;
          spaceUri: string;
          action: string;
          method: string;
        }) => permit && [...allowed, custom].includes(input.spaceUri),
      );
      const worker = createSpacesWorker({
        projection,
        lexicons,
        service: { endpoint: "https://spaces.atmo.garden", audience },
        spaceTypes: {
          "garden.atmo.circle": {
            collections: [collection],
            policy: {
              $type: "com.atproto.managedspace.policy",
              managingApp: audience,
            },
          },
        },
        authorization: {
          authorize,
          ...(customLookup
            ? { listSpaces: () => [denied[0], allowed[0], custom] }
            : {}),
        },
      });
      const runtime = worker.integrated(
        {
          DB: db,
          SPACES_CREDENTIAL_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
        context(),
      );
      const expected = [...allowed, ...(customLookup ? [custom] : [])].sort();
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await runtime.listSpaces({ userDid, limit: 2, cursor });
        expect(page.spaces.length).toBeGreaterThan(0);
        expect(page.spaces.length).toBeLessThanOrEqual(2);
        if (page.cursor) expect(expected).toContain(page.cursor);
        seen.push(...page.spaces.map((entry) => entry.uri));
        expect(seen.length).toBeLessThanOrEqual(expected.length);
        cursor = page.cursor;
        expect(page.truncated).toBe(Boolean(cursor));
      } while (cursor);
      expect(seen).toEqual(expected);
      for (const spaceUri of [...denied, ...allowed]) {
        expect(authorize).toHaveBeenCalledWith(
          {
            userDid,
            spaceUri,
            action: "read",
            method: "garden.atmo.circle.listSpaces",
          },
          expect.anything(),
        );
      }
      // Existing leases cannot override a newly denied managing-app decision.
      permit = false;
      expect(await runtime.listSpaces({ userDid, limit: 2 })).toEqual({
        spaces: [],
        truncated: false,
      });
      await expect(
        runtime.listSpaceRecords({ userDid, space: allowed[0], collection }),
      ).rejects.toMatchObject({ code: "Forbidden" });
    },
  );
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
              verificationMethod: [
                {
                  id: `${did}#atproto`,
                  type: "Multikey",
                  controller: did,
                  publicKeyMultibase: await keypair.exportPublicKey("multikey"),
                },
              ],
            };
          },
        },
      },
      standaloneUserApi: true,
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          policy: {
            $type: "com.atproto.managedspace.policy",
            managingApp: audience,
          },
          skey: "self",
        },
      },
      authorization: { authorize: () => true },
    });
    const method = "garden.atmo.circle.note.listSpaceRecords";
    const url = `https://spaces.atmo.garden/xrpc/${method}?space=${encodeURIComponent(space)}`;
    const queued: unknown[] = [];
    const env = {
      DB: db,
      SPACES_CREDENTIAL_ENCRYPTION_KEY:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      SPACES_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as never;

    const anonymous = await worker.fetch!(
      new Request(url) as never,
      env,
      context(),
    );
    expect(anonymous.status).toBe(401);

    const request = new Request(url, {
      headers: { authorization: `Bearer ${await token(method)}` },
    });
    const response = await worker.fetch!(request as never, env, context());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      records: Array<{ value: { text: string } }>;
    };
    expect(body.records.map((record) => record.value.text)).toEqual([
      "private hello",
    ]);

    const listSpacesMethod = "garden.atmo.circle.listSpaces";
    const listSpaces = await worker.fetch!(
      new Request(`https://spaces.atmo.garden/xrpc/${listSpacesMethod}`, {
        headers: { authorization: `Bearer ${await token(listSpacesMethod)}` },
      }) as never,
      env,
      context(),
    );
    expect(listSpaces.status).toBe(200);
    expect(await listSpaces.json()).toEqual({
      spaces: [
        {
          uri: space,
          authorityDid: issuer,
          type: "garden.atmo.circle",
        },
      ],
      truncated: false,
    });

    const integrated = worker.integrated(env, context());
    expect(
      (
        await integrated.listSpaceRecords<{ value: { text: string } }>({
          userDid: issuer,
          space,
          collection,
        })
      ).records.map((record) => record.value.text),
    ).toEqual(["private hello"]);

    const wrongMethod = new Request(url, {
      headers: {
        authorization: `Bearer ${await token("garden.atmo.circle.syncSpace")}`,
      },
    });
    expect(
      (await worker.fetch!(wrongMethod as never, env, context())).status,
    ).toBe(401);

    const syncMethod = "garden.atmo.circle.syncSpace";
    const targetedSync = new Request(
      `https://spaces.atmo.garden/xrpc/${syncMethod}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await token(syncMethod)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space, repo: "did:plc:unadvertised" }),
      },
    );
    expect(
      (await worker.fetch!(targetedSync as never, env, context())).status,
    ).toBe(202);
    expect(queued).toEqual([
      {
        kind: "reconcile",
        space,
        preferredRepo: "did:plc:unadvertised",
      },
    ]);
  });

  it("defaults to integrated user APIs while retaining authenticated PDS callbacks", async () => {
    const worker = createSpacesWorker({
      projection,
      lexicons,
      service: {
        endpoint: "https://spaces.atmo.garden",
        audience,
      },
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          policy: { $type: "com.atproto.memberspace.policy" },
        },
      },
    });
    const discovery = await worker.fetch!(
      new Request(
        "https://spaces.atmo.garden/.well-known/contrail-spaces-alpha",
      ) as never,
      {} as never,
      context(),
    );
    expect(((await discovery.json()) as { methods: string[] }).methods).toEqual(
      ["com.atproto.space.notifyWrite", "com.atproto.space.notifySpaceDeleted"],
    );
    const removed = await worker.fetch!(
      new Request(
        "https://spaces.atmo.garden/xrpc/garden.atmo.circle.listSpaces",
      ) as never,
      {} as never,
      context(),
    );
    expect(removed.status).toBe(404);
  });

  it("uses managedspace's exact lxm and checks both reads and writes", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, projection);
    await ensureSpaceWatch(db, { spaceUri: space });
    const authorize = vi.fn(() => true);
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
              verificationMethod: [
                {
                  id: `${did}#atproto`,
                  type: "Multikey",
                  controller: did,
                  publicKeyMultibase: await keypair.exportPublicKey("multikey"),
                },
              ],
            };
          },
        },
      },
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          policy: {
            $type: "com.atproto.managedspace.policy",
            managingApp: audience,
          },
        },
      },
      authorization: { authorize },
    });
    const env = {
      DB: db,
      SPACES_CREDENTIAL_ENCRYPTION_KEY:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    const method = "com.atproto.managedspace.checkUserAccess";
    const url = new URL(`/xrpc/${method}`, "https://spaces.atmo.garden");
    url.search = new URLSearchParams({
      space,
      user: "did:plc:bob",
      access: "read",
      clientId: "https://client.example",
    }).toString();
    const call = (jwt: string) =>
      worker.fetch!(
        new Request(url, {
          headers: { authorization: `Bearer ${jwt}` },
        }) as never,
        env,
        context(),
      );
    expect(
      (await call(await token("com.atproto.space.notifyWrite"))).status,
    ).toBe(401);
    for (const access of ["read", "write"] as const) {
      url.searchParams.set("access", access);
      const response = await call(await token(method));
      expect(await response.json()).toEqual({ authorized: true });
      expect(authorize).toHaveBeenLastCalledWith(
        {
          userDid: "did:plc:bob",
          spaceUri: space,
          action: access,
          method,
          clientId: access === "read" ? "https://client.example" : undefined,
        },
        expect.anything(),
      );
    }
    authorize.mockReturnValue(false);
    expect(await (await call(await token(method))).json()).toEqual({
      authorized: false,
    });
    authorize.mockImplementation(() => {
      throw new Error("offline");
    });
    expect((await call(await token(method))).status).toBe(500); // Authority denies callback failures.
  });

  it("requires an application authorizer only for managing-app policies", () => {
    const base = {
      projection,
      lexicons,
      service: {
        endpoint: "https://spaces.atmo.garden",
        audience,
      },
    };
    expect(() =>
      createSpacesWorker({
        ...base,
        spaceTypes: {
          // @ts-expect-error Policies must also be explicit at the type boundary.
          "garden.atmo.circle": { collections: [collection] },
        },
      }),
    ).toThrow(/explicit supported policy/);
    expect(() =>
      createSpacesWorker({
        ...base,
        spaceTypes: {
          "garden.atmo.circle": {
            collections: [collection],
            policy: {
              $type: "com.atproto.managedspace.policy",
              managingApp: audience,
            },
          },
        },
      }),
    ).toThrow(/Managing-app/);
    expect(() =>
      createSpacesWorker({
        ...base,
        spaceTypes: {
          "garden.atmo.circle": {
            collections: [collection],
            policy: { $type: "com.atproto.memberspace.policy" },
          },
        },
      }),
    ).not.toThrow();
  });
});
