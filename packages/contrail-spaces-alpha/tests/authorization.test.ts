import {
  bindRecordValidationLexicons,
  createIngestEvent,
  ingestRecords,
  resolveConfig,
} from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { describe, expect, it } from "vitest";
import { createIsolatedProjection } from "../src/isolated-projection";
import {
  ensureSpaceWatch,
  getSpaceWatch,
  hasAccessLease,
  initSpacesStorage,
  loadCredential,
  saveAccessLease,
  saveCredential,
} from "../src/storage";
import { spaceProjectionKey } from "../src/uri";
import { createSpacesWorker } from "../src/worker";

const owner = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const viewer = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const otherViewer = "did:plc:cccccccccccccccccccccccc";
const space = `at://${owner}/space/garden.atmo.circle/self`;
const otherSpace = space.replace(/self$/, "other");
const collection = "garden.atmo.circle.note";
const uri = `${space}/${owner}/${collection}/one`;
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const lexicons = [
  {
    lexicon: 1,
    id: collection,
    defs: {
      main: {
        type: "record",
        key: "any",
        record: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } },
        },
      },
    },
  },
];

async function fixture(response: () => Response | Promise<Response>) {
  const projection = resolveConfig({
    namespace: "garden.atmo.circle",
    profiles: [],
    collections: { note: { collection, validate: true } },
    validation: { verifyCid: false },
  });
  bindRecordValidationLexicons(projection, lexicons);
  const db = createSqliteDatabase(":memory:");
  await initSpacesStorage(db, projection);
  for (const spaceUri of [space, otherSpace]) {
    await ensureSpaceWatch(db, { spaceUri });
    for (const userDid of [viewer, otherViewer]) {
      await saveAccessLease(db, {
        userDid,
        spaceUri,
        generation: 1,
        expiresAt: Date.now() + 60_000,
        evidence: "original-grant",
      });
    }
  }
  await saveAccessLease(db, {
    userDid: viewer,
    spaceUri: space,
    generation: 2,
    expiresAt: Date.now() + 60_000,
    evidence: "another-generation",
  });
  await saveCredential(db, {
    spaceUri: space,
    generation: 1,
    viewerDid: otherViewer,
    encryptionKey,
    credential: {
      format: "http-signature-v1",
      token: "other-member-sync-credential",
      privateKey: "unused",
      expiresAt: Date.now() + 60_000,
    },
  });
  await ingestRecords(
    db,
    [
      createIngestEvent({
        uri,
        did: owner,
        collection,
        rkey: "one",
        operation: "create",
        cid: "test-cid",
        value: { $type: collection, text: "private content" },
        timeUs: 1_000_000,
      }),
    ],
    projection,
    {
      projection: createIsolatedProjection({
        scope: { kind: "isolated", key: spaceProjectionKey(space, 1) },
        partition: owner,
        generation: 1,
        activate: true,
      }),
      skipDiagnostics: true,
    },
  );
  const worker = createSpacesWorker({
    projection,
    lexicons,
    service: {
      endpoint: "https://provider.example",
      audience: "did:web:provider.example#spaces",
    },
    spaceTypes: {
      "garden.atmo.circle": {
        collections: [collection],
        policy: { $type: "com.atproto.memberspace.policy" },
      },
    },
    protocol: {
      async fetch(input) {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.hostname === "plc.directory") {
          return Response.json({
            id: owner,
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: "https://pds.example",
              },
            ],
          });
        }
        expect(url.pathname).toBe("/xrpc/com.atproto.space.getSpaceCredential");
        return response();
      },
    },
  });
  const runtime = worker.integrated(
    {
      DB: db,
      SPACES_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    },
    { waitUntil() {} } as unknown as ExecutionContext,
  );
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const delegation = `${part({})}.${part({ iss: viewer, sub: space, exp: Date.now() / 1000 + 60 })}.signature`;
  return {
    db,
    runtime,
    authorize: () =>
      runtime.authorizeSpace({ userDid: viewer, space, delegation }),
  };
}

describe("Space reauthorization failures", () => {
  it.each([
    ["UserNotAuthorized", 400],
    ["SpaceNotFound", 400],
    ["CredentialRevoked", 400],
    ["AppNotAuthorized", 400],
    ["AuthRequired", 401],
    ["Forbidden", 403],
  ] as const)(
    "revokes only the denied viewer's exact-Space lease on %s (%s)",
    async (code, status) => {
      const { db, runtime, authorize } = await fixture(() =>
        Response.json({ error: code }, { status }),
      );
      expect(
        (await runtime.listSpaceRecords({ userDid: viewer, space, collection }))
          .records,
      ).toHaveLength(1);
      await expect(authorize()).rejects.toMatchObject({ code });
      expect(
        await hasAccessLease(db, {
          userDid: viewer,
          spaceUri: space,
          generation: 1,
        }),
      ).toBe(false);
      await expect(
        runtime.listSpaceRecords({ userDid: viewer, space, collection }),
      ).rejects.toMatchObject({ code: "Forbidden" });
      await expect(
        runtime.getSpaceRecord({ userDid: viewer, space, collection, uri }),
      ).rejects.toMatchObject({ code: "Forbidden" });
      expect(
        (await runtime.listSpaces({ userDid: viewer })).spaces.map(
          (entry) => entry.uri,
        ),
      ).toEqual([otherSpace]);
      expect(
        (
          await runtime.getSpaceRecord<{ value: { text: string } }>({
            userDid: otherViewer,
            space,
            collection,
            uri,
          })
        ).record.value.text,
      ).toBe("private content");
      expect(
        (await runtime.listSpaceRecords({ userDid: owner, space, collection }))
          .records,
      ).toHaveLength(1);
      expect(await getSpaceWatch(db, space)).toMatchObject({
        status: "active",
        generation: 1,
      });
      expect(
        (
          await loadCredential(db, {
            spaceUri: space,
            generation: 1,
            encryptionKey,
          })
        )?.credential.token,
      ).toBe("other-member-sync-credential");
      expect(
        await hasAccessLease(db, {
          userDid: viewer,
          spaceUri: space,
          generation: 2,
        }),
      ).toBe(true);
    },
  );

  it.each(["server failure", "network failure"])(
    "keeps the previous lease on transient %s",
    async (failure) => {
      const { db, authorize } = await fixture(() => {
        if (failure === "network failure")
          throw new Error("Network unavailable");
        return Response.json({ error: "UpstreamFailure" }, { status: 503 });
      });
      await expect(authorize()).rejects.toThrow();
      expect(
        await hasAccessLease(db, {
          userDid: viewer,
          spaceUri: space,
          generation: 1,
        }),
      ).toBe(true);
    },
  );

  it("does not revoke a concurrently replaced read lease after a delayed denial", async () => {
    const { db, runtime, authorize } = await fixture(async () => {
      // A concurrent successful authorization replaced the observed grant.
      await saveAccessLease(db, {
        userDid: viewer,
        spaceUri: space,
        generation: 1,
        expiresAt: Date.now() + 60_000,
      });
      return Response.json({ error: "UserNotAuthorized" }, { status: 400 });
    });
    await expect(authorize()).rejects.toMatchObject({
      code: "UserNotAuthorized",
    });
    expect(
      await hasAccessLease(db, {
        userDid: viewer,
        spaceUri: space,
        generation: 1,
      }),
    ).toBe(true);
    expect(
      (await runtime.listSpaceRecords({ userDid: viewer, space, collection }))
        .records,
    ).toHaveLength(1);
  });
});
