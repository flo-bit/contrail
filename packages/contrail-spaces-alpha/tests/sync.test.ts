import { P256Keypair } from "@atproto/crypto";
import { lexToJson } from "@atproto/lex-json";
import {
  activateIsolatedPartitionStatement,
  bindRecordValidationProvider,
  queryIsolatedRecords,
  resolveConfig,
} from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import {
  RepoCommit,
  serializeRecord,
  serializeRepo,
  COMMIT_MAC_TYPE,
  computeCommitMac,
  computeRecordMac,
  RECORD_MAC_TYPE,
  decapsulate,
  formatMacHeader,
  parseWantMacHeader,
  type Commit,
} from "@atproto/space";
import { describe, expect, it, vi } from "vitest";
import { SpaceCredentialTransport, type RepoOp } from "../src/protocol";
import { createSpaceRecordValidation } from "../src/validation";
import {
  DEFAULT_SPACES_SYNC_BUDGET,
  resolveSpacesSyncBudget,
  SpacesSyncEngine,
} from "../src/sync";
import {
  ensureSpaceWatch,
  getRepoState,
  getSpaceWatch,
  hasAccessLease,
  initSpacesStorage,
  loadCredential,
  saveAccessLease,
  saveCredential,
  updateWatch,
  type SpaceRepoState,
  type SpaceWatch,
} from "../src/storage";
import { spaceProjectionKey } from "../src/uri";

const SPACE = "at://did:plc:alice/space/garden.atmo.circle/self";
const WRITER = "did:plc:bob";
const COLLECTION = "garden.atmo.circle.note";
const EXCLUDED_COLLECTION = "garden.atmo.circle.rsvp";

const projection = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: {
    note: { collection: COLLECTION },
  },
});

function watch(): SpaceWatch {
  return {
    spaceUri: SPACE,
    authorityDid: "did:plc:alice",
    spaceType: "garden.atmo.circle",
    generation: 1,
    status: "active",
    registrationExpiresAt: null,
    registrationPdsUrl: null,
    nextReconcileAt: 0,
    lastReconciledAt: null,
    lastError: null,
  };
}

function localState(): SpaceRepoState {
  return {
    spaceUri: SPACE,
    spaceGeneration: 1,
    repoDid: WRITER,
    pdsUrl: "https://writer.test",
    visibleWriterGeneration: 1,
    rev: "1",
    ltHash: new RepoCommit().setHash.state(),
    commitHash: new Uint8Array(32),
    removalObservations: 0,
  };
}

const kem = await P256Keypair.create();
const MEMBERS_POLICY = {
  $type: "com.atproto.memberspace.policy",
  publishPolicy: true,
};

async function policyResponse(
  headers?: HeadersInit,
  policy: Record<string, string | boolean | string[]> = MEMBERS_POLICY,
  options: { wrongUri?: boolean; badMac?: boolean; tamper?: boolean } = {},
) {
  const share = parseWantMacHeader(
    new Headers(headers).get("Atproto-Space-Want-Mac") ?? undefined,
    RECORD_MAC_TYPE,
  );
  const shared = await decapsulate(kem, share);
  const value = { $type: "com.atproto.space.policy", policy };
  const record = await serializeRecord(
    "com.atproto.space.policy",
    "self",
    value,
  );
  const uri = `${SPACE}/${options.wrongUri ? WRITER : "did:plc:alice"}/com.atproto.space.policy/self`;
  return Response.json(
    {
      uri,
      cid: record.cid.toString(),
      value: options.tamper ? { ...value, extra: true } : value,
    },
    {
      headers: {
        "Atproto-Space-Mac": formatMacHeader(
          RECORD_MAC_TYPE,
          options.badMac
            ? new Uint8Array(32)
            : computeRecordMac(shared, uri, record.cid),
        ),
      },
    },
  );
}

function policyTransport(
  policy: Parameters<typeof policyResponse>[1] = MEMBERS_POLICY,
  options: Parameters<typeof policyResponse>[2] = {},
) {
  return {
    fetch: async (
      input: string | URL,
      init?: RequestInit,
      audience?: string,
    ) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/xrpc/com.atproto.space.getRecord");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        space: SPACE,
        repo: "did:plc:alice",
        collection: "com.atproto.space.policy",
        rkey: "self",
      });
      expect(audience).toBe("did:plc:alice");
      return policyResponse(init?.headers, policy, options);
    },
  } as unknown as SpaceCredentialTransport;
}

async function connect(db: SpacesSyncEngine["db"], engine: SpacesSyncEngine) {
  await ensureSpaceWatch(db, { spaceUri: SPACE });
  const stored = new SpaceCredentialTransport(
    "credential",
    await P256Keypair.create({ exportable: true }),
    Date.now() + 60_000,
  );
  await saveCredential(db, {
    spaceUri: SPACE,
    generation: 1,
    viewerDid: WRITER,
    encryptionKey: engine.config.credentialEncryptionKey,
    credential: await stored.serialize(),
  });
}

function encodedCommit(commit: Commit): Record<string, unknown> {
  const bytes = (value: Uint8Array) => ({
    $bytes: Buffer.from(value).toString("base64url"),
  });
  return {
    ver: commit.ver,
    rev: commit.rev,
    repo: commit.repo,
    space: commit.space,
    data: bytes(commit.data),
  };
}

function transportFor(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): SpaceCredentialTransport {
  return {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const response = await handler(
        new URL(input instanceof Request ? input.url : input),
        init,
      );
      const body = (await response.clone().json()) as {
        commit?: Record<string, unknown>;
      };
      if (body.commit) {
        const share = parseWantMacHeader(
          new Headers(init?.headers).get("Atproto-Space-Want-Mac") ?? undefined,
          COMMIT_MAC_TYPE,
        );
        const shared = await decapsulate(kem, share);
        const commit = {
          ...body.commit,
          data: Uint8Array.from(
            Buffer.from(
              (body.commit.data as { $bytes: string }).$bytes,
              "base64url",
            ),
          ),
        } as Commit;
        response.headers.set(
          "Atproto-Space-Mac",
          formatMacHeader(COMMIT_MAC_TYPE, computeCommitMac(shared, commit)),
        );
      }
      return response;
    },
  } as unknown as SpaceCredentialTransport;
}

type IncrementalRepo = (
  watch: SpaceWatch,
  local: SpaceRepoState,
  transport: SpaceCredentialTransport,
  assertLease: () => Promise<void>,
  deadline?: number,
) => Promise<void>;

function incremental(engine: SpacesSyncEngine): IncrementalRepo {
  return (
    engine as unknown as { incrementalRepo: IncrementalRepo }
  ).incrementalRepo.bind(engine);
}

async function engineFor(
  syncBudget?: {
    maxIncrementalOperations?: number;
    recoveryBatchSize?: number;
  },
  config = projection,
) {
  const db = createSqliteDatabase(":memory:");
  await initSpacesStorage(db, config);
  const engine = new SpacesSyncEngine(db, {
    projection: config,
    spaceTypes: {
      "garden.atmo.circle": {
        collections: [COLLECTION],
        policy: { $type: "com.atproto.memberspace.policy" },
      },
    },
    serviceAudience: "did:web:provider.test#spaces",
    credentialEncryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    syncBudget,
  });
  vi.spyOn(engine.identities, "resolvePds").mockResolvedValue(
    "https://writer.test",
  );
  vi.spyOn(engine.identities, "resolveKemKey").mockResolvedValue(kem.did());
  return { db, engine };
}

async function validatedProjection(verifyCid = true) {
  const config = resolveConfig({
    namespace: "garden.atmo.circle",
    profiles: [],
    collections: { note: { collection: COLLECTION, validate: true } },
    validation: { verifyCid },
  });
  const validation = createSpaceRecordValidation(
    [
      {
        lexicon: 1,
        id: COLLECTION,
        defs: {
          main: {
            type: "record",
            key: "any",
            record: {
              type: "object",
              required: ["text"],
              properties: {
                text: { type: "string" },
                data: { type: "bytes" },
                ref: { type: "cid-link" },
              },
            },
          },
        },
      },
    ],
    [COLLECTION],
  );
  await validation.ready;
  bindRecordValidationProvider(config, validation.validate);
  return config;
}

type RecoverRepo = (
  watch: SpaceWatch,
  repo: string,
  transport: SpaceCredentialTransport,
  lease: () => Promise<void>,
) => Promise<void>;

function recovery(engine: SpacesSyncEngine): RecoverRepo {
  return (engine as unknown as { recoverRepo: RecoverRepo }).recoverRepo.bind(
    engine,
  );
}

function starTransport(
  commit: Commit,
  records: Awaited<ReturnType<typeof serializeRecord>>[],
): SpaceCredentialTransport {
  return {
    fetch: async (_input: unknown, init?: RequestInit) => {
      const keyShare = parseWantMacHeader(
        new Headers(init?.headers).get("Atproto-Space-Want-Mac") ?? undefined,
        COMMIT_MAC_TYPE,
      );
      const shared = await decapsulate(kem, keyShare);
      const chunks: Uint8Array[] = [];
      for await (const chunk of serializeRepo(commit, records))
        chunks.push(chunk);
      return new Response(Buffer.concat(chunks), {
        headers: {
          "Atproto-Space-Mac": formatMacHeader(
            COMMIT_MAC_TYPE,
            computeCommitMac(shared, commit),
          ),
        },
      });
    },
  } as unknown as SpaceCredentialTransport;
}

function opsTransport(ops: RepoOp[], commit: Commit): SpaceCredentialTransport {
  return transportFor(() =>
    Response.json({ ops, commit: encodedCommit(commit) }),
  );
}

describe("Spaces incremental synchronization", () => {
  it.each([true, false])(
    "rejects mismatched values before projection/checkpoint writes (verifyCid=%s)",
    async (verifyCid) => {
      const config = await validatedProjection(verifyCid);
      const { db, engine } = await engineFor(undefined, config);
      const before = { $type: COLLECTION, text: "verified" };
      const oldRecord = await serializeRecord(COLLECTION, "one", before);
      const oldCommit = RepoCommit.fromRecords([oldRecord]).toCommit({
        space: SPACE,
        repo: WRITER,
        rev: "3",
      });
      await db.batch([
        activateIsolatedPartitionStatement(db, {
          scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
          partition: WRITER,
          generation: 1,
        }),
      ]);
      await incremental(engine)(
        watch(),
        localState(),
        opsTransport(
          [
            {
              rev: "3",
              collection: COLLECTION,
              rkey: "one",
              cid: oldRecord.cid.toString(),
              prev: null,
              value: before,
            },
          ],
          oldCommit,
        ),
        async () => {},
      );
      const checkpoint = (await getRepoState(db, watch(), WRITER))!;
      const updated = await serializeRecord(COLLECTION, "one", {
        $type: COLLECTION,
        text: "updated",
      });
      const commit = RepoCommit.fromRecords([updated]).toCommit({
        space: SPACE,
        repo: WRITER,
        rev: "4",
      });
      await expect(
        incremental(engine)(
          watch(),
          checkpoint,
          opsTransport(
            [
              {
                rev: "4",
                collection: COLLECTION,
                rkey: "one",
                cid: updated.cid.toString(),
                prev: oldRecord.cid.toString(),
                value: { $type: COLLECTION, text: "tampered" },
              },
            ],
            commit,
          ),
          async () => {},
        ),
      ).rejects.toThrow(/record CID verification failed/);
      expect(await getRepoState(db, watch(), WRITER)).toEqual(checkpoint);
      const result = await queryIsolatedRecords(db, config, {
        scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
        collection: COLLECTION,
      });
      expect(result.records.map((row) => JSON.parse(row.record!))).toEqual([
        before,
      ]);
      expect(
        await db
          .prepare("SELECT source_revision FROM isolated_record_versions")
          .first(),
      ).toEqual({ source_revision: "3" });
    },
  );

  it.each(["incremental", "recovery"])(
    "preserves bytes and CID links through %s projection",
    async (mode) => {
      const config = await validatedProjection();
      const { db, engine } = await engineFor(undefined, config);
      const target = await serializeRecord(COLLECTION, "target", {
        text: "target",
      });
      const value = {
        $type: COLLECTION,
        text: "binary",
        data: new Uint8Array([1, 2, 3]),
        ref: target.cid,
      };
      const record = await serializeRecord(COLLECTION, "one", value);
      const commit = RepoCommit.fromRecords([record]).toCommit({
        space: SPACE,
        repo: WRITER,
        rev: "3",
      });
      if (mode === "incremental") {
        await db.batch([
          activateIsolatedPartitionStatement(db, {
            scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
            partition: WRITER,
            generation: 1,
          }),
        ]);
        await incremental(engine)(
          watch(),
          localState(),
          transportFor(() =>
            Response.json({
              ops: [
                {
                  rev: "3",
                  collection: COLLECTION,
                  rkey: "one",
                  cid: record.cid.toString(),
                  prev: null,
                  value: lexToJson(value),
                },
              ],
              commit: encodedCommit(commit),
            }),
          ),
          async () => {},
        );
      } else {
        await recovery(engine)(
          watch(),
          WRITER,
          starTransport(commit, [record]),
          async () => {},
        );
      }
      const result = await queryIsolatedRecords(db, config, {
        scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
        collection: COLLECTION,
      });
      expect(result.records.map((row) => JSON.parse(row.record!))).toEqual([
        lexToJson(value),
      ]);
      expect(result.records[0].cid).toBe(record.cid.toString());
      expect((await getRepoState(db, watch(), WRITER))?.rev).toBe("3");
    },
  );
  it("projects an update without recovering when its superseded create has no value", async () => {
    const { db, engine } = await engineFor();
    const oldRecord = { text: "old" };
    const currentRecord = { text: "current" };
    const [oldSerialized, currentSerialized] = await Promise.all([
      serializeRecord(COLLECTION, "one", oldRecord),
      serializeRecord(COLLECTION, "one", currentRecord),
    ]);
    const commit = RepoCommit.fromRecords([currentSerialized]).toCommit({
      space: SPACE,
      repo: WRITER,
      rev: "3",
    });
    const operations: RepoOp[] = [
      {
        rev: "2",
        collection: COLLECTION,
        rkey: "one",
        cid: oldSerialized.cid.toString(),
        prev: null,
      },
      {
        rev: "3",
        collection: COLLECTION,
        rkey: "one",
        cid: currentSerialized.cid.toString(),
        prev: oldSerialized.cid.toString(),
        value: currentRecord,
      },
    ];
    const transport = transportFor(
      () =>
        new Response(
          JSON.stringify({
            ops: operations,
            commit: encodedCommit(commit),
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );

    await db.batch([
      activateIsolatedPartitionStatement(db, {
        scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
        partition: WRITER,
        generation: 1,
      }),
    ]);
    await incremental(engine)(watch(), localState(), transport, async () => {});

    const result = await queryIsolatedRecords(db, projection, {
      scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
      collection: COLLECTION,
    });
    expect(result.records).toHaveLength(1);
    expect(JSON.parse(result.records[0].record!)).toEqual(currentRecord);
    expect((await getRepoState(db, watch(), WRITER))?.rev).toBe("3");
  });

  it("projects a delete without recovering when its superseded create has no value", async () => {
    const { db, engine } = await engineFor();
    const created = await serializeRecord(COLLECTION, "one", {
      text: "temporary",
    });
    const commit = new RepoCommit().toCommit({
      space: SPACE,
      repo: WRITER,
      rev: "3",
    });
    const operations: RepoOp[] = [
      {
        rev: "2",
        collection: COLLECTION,
        rkey: "one",
        cid: created.cid.toString(),
        prev: null,
      },
      {
        rev: "3",
        collection: COLLECTION,
        rkey: "one",
        cid: null,
        prev: created.cid.toString(),
      },
    ];
    const transport = transportFor(
      () =>
        new Response(
          JSON.stringify({
            ops: operations,
            commit: encodedCommit(commit),
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );

    await incremental(engine)(watch(), localState(), transport, async () => {});

    const result = await queryIsolatedRecords(db, projection, {
      scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
      collection: COLLECTION,
    });
    expect(result.records).toEqual([]);
    expect(
      await db
        .prepare(
          `SELECT operation FROM isolated_record_versions
       WHERE scope_key = ? AND partition_key = ? AND partition_generation = ?`,
        )
        .bind(spaceProjectionKey(SPACE, 1), WRITER, 1)
        .first(),
    ).toEqual({
      operation: "delete",
    });
    expect((await getRepoState(db, watch(), WRITER))?.rev).toBe("3");
  });

  it("counts excluded-collection operations against the whole-repo limit", async () => {
    const { engine } = await engineFor({ maxIncrementalOperations: 2 });
    let requestedLimit: string | null = null;
    const transport = transportFor((url) => {
      requestedLimit = url.searchParams.get("limit");
      return new Response(
        JSON.stringify({
          ops: ["one", "two", "three"].map(
            (rkey, index): RepoOp => ({
              rev: String(index + 2),
              collection: EXCLUDED_COLLECTION,
              rkey,
              cid: null,
              prev: null,
            }),
          ),
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      incremental(engine)(watch(), localState(), transport, async () => {}),
    ).rejects.toThrow(/bounded operation limit/);
    expect(requestedLimit).toBe("3");
  });

  it("stops between operation pages at the reconciliation deadline", async () => {
    const { engine } = await engineFor();
    let now = 100;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let requests = 0;
    const transport = transportFor(() => {
      requests++;
      now = 200;
      return new Response(JSON.stringify({ ops: [], cursor: "next" }), {
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await expect(
        incremental(engine)(
          watch(),
          localState(),
          transport,
          async () => {},
          150,
        ),
      ).rejects.toThrow(/deadline reached/);
      expect(requests).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("Space policy and authorization checks", () => {
  it.each(["repo", "reconcile", "registration"])(
    "does not replay revoked credentials across %s jobs or engine instances",
    async (mode) => {
      const { db, engine } = await engineFor();
      await ensureSpaceWatch(db, { spaceUri: SPACE });
      const value = { text: "keep verified content" };
      const record = await serializeRecord(COLLECTION, "one", value);
      const commit = RepoCommit.fromRecords([record]).toCommit({
        space: SPACE,
        repo: WRITER,
        rev: "3",
      });
      await recovery(engine)(
        watch(),
        WRITER,
        starTransport(commit, [record]),
        async () => {},
      );
      const checkpoint = await getRepoState(db, watch(), WRITER);
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const request = input as Request;
        if (
          mode === "registration" &&
          new URL(request.url).pathname.endsWith("getRecord")
        ) {
          return policyResponse(request.headers);
        }
        return Response.json({ error: "CredentialRevoked" }, { status: 401 });
      });
      engine.config.protocol = { fetch: fetchImpl };
      const stored = new SpaceCredentialTransport(
        "revoked-token",
        await P256Keypair.create({ exportable: true }),
        Date.now() + 60_000,
      );
      await saveCredential(db, {
        spaceUri: SPACE,
        generation: 1,
        viewerDid: WRITER,
        encryptionKey: engine.config.credentialEncryptionKey,
        credential: await stored.serialize(),
      });
      await saveAccessLease(db, {
        userDid: WRITER,
        spaceUri: SPACE,
        generation: 1,
        expiresAt: Date.now() + 60_000,
      });
      await expect(
        mode === "repo"
          ? engine.syncRepo(SPACE, WRITER)
          : engine.reconcileSpace(SPACE),
      ).rejects.toMatchObject({ code: "CredentialRevoked" });
      expect(fetchImpl).toHaveBeenCalledTimes(mode === "registration" ? 2 : 1);
      expect((await getSpaceWatch(db, SPACE))?.status).toBe("paused");
      expect(
        await loadCredential(db, {
          spaceUri: SPACE,
          generation: 1,
          encryptionKey: engine.config.credentialEncryptionKey,
        }),
      ).toBeNull();
      expect(
        await hasAccessLease(db, {
          userDid: WRITER,
          spaceUri: SPACE,
          generation: 1,
        }),
      ).toBe(false);
      const restarted = new SpacesSyncEngine(db, engine.config);
      await restarted.syncRepo(SPACE, WRITER);
      await restarted.reconcileSpace(SPACE);
      expect(fetchImpl).toHaveBeenCalledTimes(mode === "registration" ? 2 : 1);
      expect(await getRepoState(db, watch(), WRITER)).toEqual(checkpoint);
      const result = await queryIsolatedRecords(db, projection, {
        scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
        collection: COLLECTION,
      });
      expect(result.records.map((row) => JSON.parse(row.record!))).toEqual([
        value,
      ]);
    },
  );
  it("authenticates the authority's published policy, including public read/write flags", async () => {
    const { engine } = await engineFor();
    await expect(
      engine.validateWatch(watch(), policyTransport()),
    ).resolves.toBeUndefined();
    for (const flag of ["publicRead", "publicWrite"]) {
      await expect(
        engine.validateWatch(
          watch(),
          policyTransport({ ...MEMBERS_POLICY, [flag]: true }),
        ),
      ).rejects.toMatchObject({ code: "PolicyMismatch" });
    }
    await expect(
      engine.validateWatch(
        watch(),
        policyTransport({ ...MEMBERS_POLICY, publishPolicy: false }),
      ),
    ).rejects.toMatchObject({ code: "PolicyMismatch" });
  });
  it.each([{ wrongUri: true }, { badMac: true }, { tamper: true }])(
    "rejects unauthenticated policy metadata: %j",
    async (options) => {
      const { engine } = await engineFor();
      await expect(
        engine.validateWatch(watch(), policyTransport(MEMBERS_POLICY, options)),
      ).rejects.toMatchObject({ code: "PolicyVerificationFailed" });
      expect(engine.identities.resolveKemKey).toHaveBeenLastCalledWith(
        "did:plc:alice",
        true,
      );
    },
  );
  it("refreshes the authority KEM key and uses a fresh share after policy MAC failure", async () => {
    const { engine } = await engineFor();
    const shares: string[] = [];
    const transport = {
      fetch: async (_input: unknown, init?: RequestInit) => {
        shares.push(
          parseWantMacHeader(
            new Headers(init?.headers).get("Atproto-Space-Want-Mac") ??
              undefined,
            RECORD_MAC_TYPE,
          ),
        );
        return policyResponse(init?.headers, MEMBERS_POLICY, {
          badMac: shares.length === 1,
        });
      },
    } as unknown as SpaceCredentialTransport;
    await engine.validateWatch(watch(), transport);
    expect(shares).toHaveLength(2);
    expect(new Set(shares).size).toBe(2);
    expect(engine.identities.resolveKemKey).toHaveBeenLastCalledWith(
      "did:plc:alice",
      true,
    );
  });
  it("requires owner action for an unpublished policy, without treating it as deletion", async () => {
    const { db, engine } = await engineFor();
    await connect(db, engine);
    engine.config.protocol = {
      fetch: async () =>
        Response.json({ error: "RecordNotFound" }, { status: 400 }),
    };
    await expect(engine.reconcileSpace(SPACE)).rejects.toMatchObject({
      code: "PolicyNotPublished",
    });
    expect((await getSpaceWatch(db, SPACE))?.status).toBe("paused");
    expect((await getSpaceWatch(db, SPACE))?.generation).toBe(1);
  });
  it("rejects unsupported policies and app allowlists, and binds managedspace to this app", async () => {
    const { engine } = await engineFor();
    for (const policy of [
      { $type: "unknown.policy", publishPolicy: true },
      { $type: "com.atproto.personalspace.policy", publishPolicy: true },
      { ...MEMBERS_POLICY, allowedApps: ["https://client.example"] },
    ]) {
      await expect(
        engine.validateWatch(watch(), policyTransport(policy)),
      ).rejects.toMatchObject({ code: "PolicyMismatch" });
    }
    engine.config.spaceTypes["garden.atmo.circle"].policy = {
      $type: "com.atproto.managedspace.policy",
      managingApp: engine.config.serviceAudience,
    };
    await expect(
      engine.validateWatch(
        watch(),
        policyTransport({
          $type: "com.atproto.managedspace.policy",
          managingApp: engine.config.serviceAudience,
          publishPolicy: true,
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      engine.validateWatch(
        watch(),
        policyTransport({
          $type: "com.atproto.managedspace.policy",
          managingApp: "did:web:other.example",
          publishPolicy: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "PolicyMismatch" });
  });
  it("does not replay a revoked credential", async () => {
    const { engine } = await engineFor();
    let requests = 0;
    const transport = {
      fetch: async () => {
        requests++;
        return Response.json({ error: "CredentialRevoked" }, { status: 401 });
      },
    } as unknown as SpaceCredentialTransport;
    await expect(
      incremental(engine)(watch(), localState(), transport, async () => {}),
    ).rejects.toMatchObject({ code: "CredentialRevoked" });
    expect(requests).toBe(1);
  });
  it("does not checkpoint a response with a missing MAC", async () => {
    const { db, engine } = await engineFor();
    const commit = new RepoCommit().toCommit({
      space: SPACE,
      repo: WRITER,
      rev: "3",
    });
    const transport = {
      fetch: async () =>
        Response.json({ ops: [], commit: encodedCommit(commit) }),
    } as unknown as SpaceCredentialTransport;
    await expect(
      incremental(engine)(watch(), localState(), transport, async () => {}),
    ).rejects.toThrow(/MAC/);
    expect(await getRepoState(db, watch(), WRITER)).toBeNull();
  });
});

describe("October 29 sync lifecycle", () => {
  it("recovers after clearRecords, removing absent records only after authenticating the empty repo", async () => {
    const { db, engine } = await engineFor();
    await connect(db, engine);
    const record = await serializeRecord(COLLECTION, "one", {
      text: "before clear",
    });
    const before = RepoCommit.fromRecords([record]).toCommit({
      space: SPACE,
      repo: WRITER,
      rev: "1",
    });
    await recovery(engine)(
      watch(),
      WRITER,
      starTransport(before, [record]),
      async () => {},
    );
    const empty = new RepoCommit().toCommit({
      space: SPACE,
      repo: WRITER,
      rev: "2",
    });
    expect(Buffer.from(empty.data).toString("hex")).toBe(
      "e5a00aa9991ac8a5ee3109844d84a55583bd20572ad3ffcd42792f3c36b183ad",
    );
    const paths: string[] = [];
    engine.config.protocol = {
      fetch: async (input) => {
        const request = input as Request;
        const path = new URL(request.url).pathname;
        paths.push(path);
        return (
          path.endsWith("listRepoOps")
            ? opsTransport([], empty)
            : starTransport(empty, [])
        ).fetch(request, { headers: request.headers }, WRITER);
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await engine.syncRepo(SPACE, WRITER);
    } finally {
      warn.mockRestore();
    }
    expect(paths).toEqual([
      "/xrpc/com.atproto.space.listRepoOps",
      "/xrpc/com.atproto.space.getRepo",
    ]);
    const checkpoint = await getRepoState(db, watch(), WRITER);
    expect(checkpoint?.rev).toBe("2");
    expect(checkpoint?.visibleWriterGeneration).toBe(2);
    expect(checkpoint?.commitHash).toEqual(empty.data);
    expect(
      (
        await queryIsolatedRecords(db, projection, {
          scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
          collection: COLLECTION,
        })
      ).records,
    ).toEqual([]);
  });

  it("advances a migrated repo checkpoint with unchanged data and no operations", async () => {
    const { db, engine } = await engineFor();
    const record = await serializeRecord(COLLECTION, "one", {
      text: "preserved",
    });
    const state = RepoCommit.fromRecords([record]);
    await recovery(engine)(
      watch(),
      WRITER,
      starTransport(state.toCommit({ space: SPACE, repo: WRITER, rev: "1" }), [
        record,
      ]),
      async () => {},
    );
    const before = (await getRepoState(db, watch(), WRITER))!;
    vi.mocked(engine.identities.resolvePds).mockResolvedValue(
      "https://new-writer.test",
    );
    await incremental(engine)(
      watch(),
      before,
      opsTransport(
        [],
        state.toCommit({ space: SPACE, repo: WRITER, rev: "2" }),
      ),
      async () => {},
    );
    expect(await getRepoState(db, watch(), WRITER)).toMatchObject({
      rev: "2",
      pdsUrl: "https://new-writer.test",
      visibleWriterGeneration: 1,
      commitHash: before.commitHash,
    });
    expect(
      (
        await queryIsolatedRecords(db, projection, {
          scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
          collection: COLLECTION,
        })
      ).records,
    ).toHaveLength(1);
  });

  it("re-registers at a migrated authority before expiry, without deleting omitted writers", async () => {
    const { db, engine } = await engineFor();
    await connect(db, engine);
    const record = await serializeRecord(COLLECTION, "one", {
      text: "not deleted by writer removal",
    });
    const commit = RepoCommit.fromRecords([record]).toCommit({
      space: SPACE,
      repo: WRITER,
      rev: "1",
    });
    await recovery(engine)(
      watch(),
      WRITER,
      starTransport(commit, [record]),
      async () => {},
    );
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await updateWatch(db, SPACE, {
      registrationExpiresAt: expiresAt,
      registrationPdsUrl: "https://old-authority.test",
    });
    vi.mocked(engine.identities.resolvePds).mockResolvedValue(
      "https://new-authority.test",
    );
    const paths: string[] = [];
    engine.config.protocol = {
      fetch: async (input) => {
        const request = input as Request;
        const url = new URL(request.url);
        expect(url.origin).toBe("https://new-authority.test");
        paths.push(url.pathname);
        if (url.pathname.endsWith("getRecord"))
          return policyResponse(request.headers);
        if (url.pathname.endsWith("registerNotify"))
          return Response.json({ expiresAt });
        if (url.pathname.endsWith("listRepos"))
          return Response.json({ repos: [] });
        throw new Error(`Unexpected request ${url}`);
      },
    };
    await engine.reconcileSpace(SPACE);
    expect((await getSpaceWatch(db, SPACE))?.registrationPdsUrl).toBe(
      "https://new-authority.test",
    );
    await engine.reconcileSpace(SPACE);
    expect(
      paths.filter((path) => path.endsWith("registerNotify")),
    ).toHaveLength(1);
    expect(await getRepoState(db, watch(), WRITER)).not.toBeNull();
    expect(
      (
        await queryIsolatedRecords(db, projection, {
          scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
          collection: COLLECTION,
        })
      ).records,
    ).toHaveLength(1);
  });

  it("pauses on SpaceNotFound without purging verified data or changing generation", async () => {
    const { db, engine } = await engineFor();
    await connect(db, engine);
    const record = await serializeRecord(COLLECTION, "one", {
      text: "retained",
    });
    const commit = RepoCommit.fromRecords([record]).toCommit({
      space: SPACE,
      repo: WRITER,
      rev: "1",
    });
    await recovery(engine)(
      watch(),
      WRITER,
      starTransport(commit, [record]),
      async () => {},
    );
    engine.config.protocol = {
      fetch: async () =>
        Response.json({ error: "SpaceNotFound" }, { status: 400 }),
    };
    await expect(engine.reconcileSpace(SPACE)).rejects.toMatchObject({
      code: "SpaceNotFound",
      accessDenied: true,
      deleted: false,
    });
    expect(await getSpaceWatch(db, SPACE)).toMatchObject({
      status: "paused",
      generation: 1,
    });
    expect(await getRepoState(db, watch(), WRITER)).not.toBeNull();
    expect(
      (
        await queryIsolatedRecords(db, projection, {
          scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
          collection: COLLECTION,
        })
      ).records,
    ).toHaveLength(1);
  });
});

describe("STAR recovery", () => {
  it("verifies a full archive before activating it, and preserves it after a failed replacement", async () => {
    const { db, engine } = await engineFor();
    const record = await serializeRecord(COLLECTION, "one", {
      text: "verified",
    });
    const commit = RepoCommit.fromRecords([record]).toCommit({
      space: SPACE,
      repo: WRITER,
      rev: "3",
    });
    let corrupt = false;
    let requests = 0;
    const shares = new Set<string>();
    const transport = {
      fetch: async (_input: unknown, init?: RequestInit) => {
        requests++;
        const keyShare = parseWantMacHeader(
          new Headers(init?.headers).get("Atproto-Space-Want-Mac") ?? undefined,
          COMMIT_MAC_TYPE,
        );
        shares.add(keyShare);
        const shared = await decapsulate(kem, keyShare);
        const chunks: Uint8Array[] = [];
        for await (const chunk of serializeRepo(commit, [record]))
          chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        return new Response(bytes, {
          headers: {
            "Atproto-Space-Mac": formatMacHeader(
              COMMIT_MAC_TYPE,
              corrupt ? new Uint8Array(32) : computeCommitMac(shared, commit),
            ),
          },
        });
      },
    } as unknown as SpaceCredentialTransport;
    const recover = (
      engine as unknown as {
        recoverRepo(
          watch: SpaceWatch,
          repo: string,
          transport: SpaceCredentialTransport,
          lease: () => Promise<void>,
        ): Promise<void>;
      }
    ).recoverRepo.bind(engine);
    await recover(watch(), WRITER, transport, async () => {});
    expect((await getRepoState(db, watch(), WRITER))?.rev).toBe("3");
    corrupt = true;
    await expect(
      recover(watch(), WRITER, transport, async () => {}),
    ).rejects.toThrow(/verification/);
    const result = await queryIsolatedRecords(db, projection, {
      scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
      collection: COLLECTION,
    });
    expect(result.records.map((row) => JSON.parse(row.record!).text)).toEqual([
      "verified",
    ]);
    expect(
      (await getRepoState(db, watch(), WRITER))?.visibleWriterGeneration,
    ).toBe(1);
    expect(requests).toBe(3);
    expect(shares.size).toBe(3);
    expect(engine.identities.resolveKemKey).toHaveBeenLastCalledWith(
      WRITER,
      true,
    );
  });
});

describe("Spaces sync budget", () => {
  it("keeps incremental and recovery bounds independent", () => {
    expect(resolveSpacesSyncBudget()).toEqual(DEFAULT_SPACES_SYNC_BUDGET);
    expect(resolveSpacesSyncBudget({ maxIncrementalOperations: 4 })).toEqual({
      maxIncrementalOperations: 4,
      recoveryBatchSize: 50,
    });
    expect(resolveSpacesSyncBudget({ recoveryBatchSize: 20 })).toEqual({
      maxIncrementalOperations: 10,
      recoveryBatchSize: 20,
    });
    expect(() => resolveSpacesSyncBudget({ recoveryBatchSize: 0 })).toThrow(
      "syncBudget.recoveryBatchSize must be an integer from 1 through 50",
    );
  });
});
