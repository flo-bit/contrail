import { P256Keypair } from "@atproto/crypto";
import { resolveConfig } from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { queryIsolatedRecords } from "../src/isolated-projection";
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
} from "@atproto/space";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceCredentialTransport } from "../src/protocol";
import { SpacesSyncEngine, type SpacesSyncConfig } from "../src/sync";
import {
  acquireSyncLease,
  advanceSpaceRev,
  ensureSpaceWatch,
  getRepoState,
  getSpaceWatch,
  hasAccessLease,
  initSpacesStorage,
  listRepoFailures,
  loadCredential,
  recordRepoFailure,
  releaseSyncLease,
  saveCredential,
} from "../src/storage";
import { spaceProjectionKey } from "../src/uri";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CAROL = "did:plc:carol";
const SPACE = `at://${ALICE}/space/garden.atmo.circle/self`;
const COLLECTION = "garden.atmo.circle.note";
const HOSTS: Record<string, string> = {
  [ALICE]: "https://authority.test",
  [BOB]: "https://bob.test",
  [CAROL]: "https://carol.test",
};
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const WATCH = { spaceUri: SPACE, generation: 1 };

const projection = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: { note: { collection: COLLECTION } },
});
const kem = await P256Keypair.create();

type Handler = (url: URL, request: Request) => Response | Promise<Response>;
const xrpcError =
  (error: string, status = 400) =>
  () =>
    Response.json({ error }, { status });

async function macSecret(request: Request, type: typeof COMMIT_MAC_TYPE) {
  return decapsulate(
    kem,
    parseWantMacHeader(
      request.headers.get("Atproto-Space-Want-Mac") ?? undefined,
      type,
    ),
  );
}

/** A writer's repo host serving one repo: an archive, and an operation log
 * that reports no operations (so any change is picked up by recovery). */
function writerHost(repo: string, state: { rev: string; notes: string[] }) {
  return async (url: URL, request: Request) => {
    const records = await Promise.all(
      state.notes.map((text, index) =>
        serializeRecord(COLLECTION, `note${index}`, { text }),
      ),
    );
    const commit = RepoCommit.fromRecords(records).toCommit({
      space: SPACE,
      repo: repo as never,
      rev: state.rev,
    });
    const mac = formatMacHeader(
      COMMIT_MAC_TYPE,
      computeCommitMac(await macSecret(request, COMMIT_MAC_TYPE), commit),
    );
    if (url.pathname.endsWith("getRepo")) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of serializeRepo(commit, records))
        chunks.push(chunk);
      return new Response(Buffer.concat(chunks), {
        headers: { "Atproto-Space-Mac": mac },
      });
    }
    return Response.json(
      {
        ops: [],
        commit: {
          ver: commit.ver,
          rev: commit.rev,
          repo: commit.repo,
          space: commit.space,
          data: { $bytes: Buffer.from(commit.data).toString("base64") },
        },
      },
      { headers: { "Atproto-Space-Mac": mac } },
    );
  };
}

async function commitHash(
  repo: string,
  state: { rev: string; notes: string[] },
) {
  const records = await Promise.all(
    state.notes.map((text, index) =>
      serializeRecord(COLLECTION, `note${index}`, { text }),
    ),
  );
  return RepoCommit.fromRecords(records).toCommit({
    space: SPACE,
    repo: repo as never,
    rev: state.rev,
  }).data;
}

interface Listed {
  did: string;
  state: { rev: string; notes: string[] };
  spaceRev: string;
}

/** The Space authority: published policy, registration and the writer
 * listing, ordered by space revision and filtered by cursor. */
function authority(listing: () => Listed[], cursors: (string | null)[] = []) {
  return async (url: URL, request: Request) => {
    if (url.pathname.endsWith("getRecord")) {
      const value = {
        $type: "com.atproto.space.policy",
        policy: {
          $type: "com.atproto.memberspace.policy",
          publishPolicy: true,
        },
      };
      const record = await serializeRecord(
        "com.atproto.space.policy",
        "self",
        value,
      );
      const uri = `${SPACE}/${ALICE}/com.atproto.space.policy/self`;
      const shared = await decapsulate(
        kem,
        parseWantMacHeader(
          request.headers.get("Atproto-Space-Want-Mac") ?? undefined,
          RECORD_MAC_TYPE,
        ),
      );
      return Response.json(
        { uri, cid: record.cid.toString(), value },
        {
          headers: {
            "Atproto-Space-Mac": formatMacHeader(
              RECORD_MAC_TYPE,
              computeRecordMac(shared, uri, record.cid),
            ),
          },
        },
      );
    }
    if (url.pathname.endsWith("registerNotify")) {
      return Response.json({
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      });
    }
    if (url.pathname.endsWith("listRepos")) {
      const cursor = url.searchParams.get("cursor");
      if (url.searchParams.get("limit") !== "1") cursors.push(cursor);
      const repos = await Promise.all(
        listing()
          .filter((entry) => !cursor || entry.spaceRev > cursor)
          .sort((left, right) => (left.spaceRev < right.spaceRev ? -1 : 1))
          .map(async (entry) => ({
            did: entry.did,
            repoRev: entry.state.rev,
            data: {
              $bytes: Buffer.from(
                await commitHash(entry.did, entry.state),
              ).toString("base64"),
            },
            spaceRev: entry.spaceRev,
          })),
      );
      return Response.json({ repos, cursor: repos.at(-1)?.spaceRev });
    }
    throw new Error(`Unexpected authority request ${url}`);
  };
}

async function setup(config: Partial<SpacesSyncConfig> = {}) {
  const db = createSqliteDatabase(":memory:");
  await initSpacesStorage(db, projection);
  const engine = new SpacesSyncEngine(db, {
    projection,
    spaceTypes: {
      "garden.atmo.circle": {
        collections: [COLLECTION],
        policy: { $type: "com.atproto.memberspace.policy" },
      },
    },
    serviceAudience: "did:web:provider.test#spaces",
    credentialEncryptionKey: KEY,
    logger: { log() {}, warn() {}, error() {} },
    ...config,
  });
  vi.spyOn(engine.identities, "resolvePds").mockImplementation(
    async (did) => HOSTS[did],
  );
  vi.spyOn(engine.identities, "resolveKemKey").mockResolvedValue(kem.did());
  const calls: string[] = [];
  const serve = (handlers: Record<string, Handler>) => {
    engine.config.protocol = {
      fetch: async (input) => {
        const request = input as Request;
        const url = new URL(request.url);
        calls.push(`${url.host}:${url.pathname.split(".").at(-1)}`);
        const handler = Object.entries(handlers).find(
          ([did]) => HOSTS[did] === url.origin,
        )?.[1];
        if (!handler) throw new Error(`No host for ${url}`);
        return handler(url, request);
      },
    };
  };
  await ensureSpaceWatch(db, { spaceUri: SPACE });
  const connect = async () =>
    saveCredential(db, {
      spaceUri: SPACE,
      generation: 1,
      viewerDid: BOB,
      encryptionKey: KEY,
      credential: await new SpaceCredentialTransport(
        "credential",
        await P256Keypair.create({ exportable: true }),
        Date.now() + 30 * 60_000,
      ).serialize(),
    });
  const notes = async () =>
    (
      await queryIsolatedRecords(db, projection, {
        scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
        collection: COLLECTION,
      })
    ).records
      .map((row) => JSON.parse(row.record!).text as string)
      .sort();
  return { db, engine, calls, serve, connect, notes };
}

afterEach(() => vi.restoreAllMocks());

describe("writer hosts are not the Space authority", () => {
  it.each([
    ["SpaceDeleted", 400],
    ["CredentialRevoked", 401],
    ["SpaceNotFound", 400],
    ["AuthRequired", 401],
    ["Forbidden", 403],
  ])(
    "keeps the Space when a member's host answers %s",
    async (code, status) => {
      const { db, engine, calls, serve, connect, notes } = await setup();
      await connect();
      const bob = { rev: "1", notes: ["from bob"] };
      const listing = () => [{ did: BOB, state: bob, spaceRev: "1" }];
      serve({ [ALICE]: authority(listing), [BOB]: writerHost(BOB, bob) });
      await engine.syncRepo(SPACE, BOB);
      expect(await notes()).toEqual(["from bob"]);

      calls.length = 0;
      serve({ [ALICE]: authority(listing), [BOB]: xrpcError(code, status) });
      await expect(engine.syncRepo(SPACE, BOB)).resolves.toMatchObject({
        outcome: "failed",
      });
      // The claim was checked with the authority, which did not agree.
      expect(calls).toEqual([
        "bob.test:listRepoOps",
        "authority.test:listRepos",
      ]);
      expect(await getSpaceWatch(db, SPACE)).toMatchObject({
        status: "active",
        generation: 1,
      });
      expect(
        await loadCredential(db, { ...WATCH, encryptionKey: KEY }),
      ).not.toBeNull();
      expect(await notes()).toEqual(["from bob"]);
      expect(await listRepoFailures(db, WATCH)).toMatchObject([
        { repoDid: BOB, failures: 1 },
      ]);
    },
  );

  it("purges only once the authority confirms deletion", async () => {
    const { db, engine, serve, connect, notes } = await setup();
    await connect();
    const bob = { rev: "1", notes: ["from bob"] };
    serve({ [ALICE]: authority(() => []), [BOB]: writerHost(BOB, bob) });
    await engine.syncRepo(SPACE, BOB);
    serve({
      [ALICE]: xrpcError("SpaceDeleted"),
      [BOB]: xrpcError("SpaceDeleted"),
    });
    await expect(engine.syncRepo(SPACE, BOB)).resolves.toMatchObject({
      outcome: "deleted",
    });
    expect(await getSpaceWatch(db, SPACE)).toMatchObject({
      status: "hidden",
      generation: 2,
    });
    expect(await notes()).toEqual([]);
  });

  it("drops the credential once the authority confirms revocation", async () => {
    const { db, engine, serve, connect } = await setup();
    await connect();
    const bob = { rev: "1", notes: ["from bob"] };
    serve({ [ALICE]: authority(() => []), [BOB]: writerHost(BOB, bob) });
    await engine.syncRepo(SPACE, BOB);
    serve({
      [ALICE]: xrpcError("CredentialRevoked", 401),
      [BOB]: xrpcError("CredentialRevoked", 401),
    });
    await expect(engine.syncRepo(SPACE, BOB)).rejects.toMatchObject({
      code: "CredentialRevoked",
    });
    expect((await getSpaceWatch(db, SPACE))?.status).toBe("paused");
    expect(
      await loadCredential(db, { ...WATCH, encryptionKey: KEY }),
    ).toBeNull();
  });

  it("still trusts the authority's host for its own repo", async () => {
    const { db, engine, serve, connect } = await setup();
    await connect();
    serve({ [ALICE]: xrpcError("SpaceDeleted") });
    await expect(engine.syncRepo(SPACE, ALICE)).resolves.toMatchObject({
      outcome: "deleted",
    });
    expect((await getSpaceWatch(db, SPACE))?.status).toBe("hidden");
  });
});

describe("per-writer failure isolation", () => {
  it("syncs the remaining writers, backs off the failing one and retries it from the retry list", async () => {
    const { db, engine, calls, serve, connect, notes } = await setup();
    await connect();
    const bob = { rev: "1", notes: ["from bob"] };
    const carol = { rev: "1", notes: ["from carol"] };
    const cursors: (string | null)[] = [];
    const listing = () => [
      { did: BOB, state: bob, spaceRev: "1" },
      { did: CAROL, state: carol, spaceRev: "2" },
    ];
    serve({
      [ALICE]: authority(listing, cursors),
      [BOB]: xrpcError("InternalServerError", 500),
      [CAROL]: writerHost(CAROL, carol),
    });
    await engine.reconcileSpace(SPACE);
    expect(await notes()).toEqual(["from carol"]);
    expect(await getSpaceWatch(db, SPACE)).toMatchObject({
      status: "active",
      lastError: null,
      spaceRev: "2",
      consecutiveFailures: 0,
    });
    expect(await listRepoFailures(db, WATCH)).toMatchObject([
      { repoDid: BOB, failures: 1 },
    ]);

    // Backing off: the failing host is left alone, and the listing is
    // incremental from the processed revision.
    calls.length = 0;
    await engine.reconcileSpace(SPACE);
    expect(calls.filter((call) => call.startsWith("bob.test"))).toEqual([]);
    // The first pass listed everything (and asked once more for the end);
    // this one starts at the checkpoint.
    expect(cursors).toEqual([null, "2", "2"]);

    // Once due, it is retried even though the listing no longer names it.
    await db.prepare(`UPDATE spaces_repo_failures SET retry_after = 0`).run();
    serve({
      [ALICE]: authority(listing, cursors),
      [BOB]: writerHost(BOB, bob),
      [CAROL]: writerHost(CAROL, carol),
    });
    await engine.reconcileSpace(SPACE);
    expect(cursors.at(-1)).toBe("2");
    expect(await notes()).toEqual(["from bob", "from carol"]);
    expect(await listRepoFailures(db, WATCH)).toEqual([]);
  });

  it("resumes an interrupted pass immediately and from where it stopped", async () => {
    const { db, engine, serve, connect, notes } = await setup();
    await connect();
    const bob = { rev: "1", notes: ["from bob"] };
    const carol = { rev: "1", notes: ["from carol"] };
    serve({
      [ALICE]: authority(() => [
        { did: BOB, state: bob, spaceRev: "1" },
        { did: CAROL, state: carol, spaceRev: "2" },
      ]),
      [BOB]: async (url, request) => {
        // Time runs out while the first writer is being read.
        await new Promise((resolve) => setTimeout(resolve, 200));
        return writerHost(BOB, bob)(url, request);
      },
      [CAROL]: writerHost(CAROL, carol),
    });
    await engine.reconcileSpace(SPACE, { deadline: Date.now() + 150 });
    expect(await notes()).toEqual(["from bob"]);
    const interrupted = (await getSpaceWatch(db, SPACE))!;
    // Carol was not reached, so the checkpoint stays behind her.
    expect(interrupted.spaceRev).toBeNull();
    expect(interrupted.lastFullReconcileAt).toBeNull();
    expect(interrupted.nextReconcileAt).toBeLessThanOrEqual(Date.now());

    await engine.reconcileSpace(SPACE);
    expect(await notes()).toEqual(["from bob", "from carol"]);
    expect((await getSpaceWatch(db, SPACE))?.spaceRev).toBe("2");
  });

  it("retries a full pass when a writer is busy instead of stamping fullReconciledAt", async () => {
    const { db, engine, serve, connect, notes } = await setup();
    await connect();
    const bob = { rev: "1", notes: ["from bob"] };
    const carol = { rev: "1", notes: ["from carol"] };
    const cursors: (string | null)[] = [];
    serve({
      [ALICE]: authority(
        () => [
          { did: BOB, state: bob, spaceRev: "1" },
          { did: CAROL, state: carol, spaceRev: "2" },
        ],
        cursors,
      ),
      [BOB]: writerHost(BOB, bob),
      [CAROL]: writerHost(CAROL, carol),
    });

    // Establish an earlier checkpoint so an incremental pass would skip Bob.
    await advanceSpaceRev(db, WATCH, { spaceRev: "2" });
    await acquireSyncLease(db, {
      ...WATCH,
      repoDid: BOB,
      owner: "other-worker",
      ttlMs: 60_000,
    });

    await engine.reconcileSpace(SPACE);
    expect(await notes()).toEqual(["from carol"]);
    const afterBusy = (await getSpaceWatch(db, SPACE))!;
    expect(afterBusy.lastFullReconcileAt).toBeNull();
    expect(afterBusy.nextReconcileAt).toBeLessThanOrEqual(Date.now());

    await releaseSyncLease(db, {
      ...WATCH,
      repoDid: BOB,
      owner: "other-worker",
    });
    await engine.reconcileSpace(SPACE);
    expect(cursors).toEqual([null, "2", null, "2"]);
    expect(await notes()).toEqual(["from bob", "from carol"]);
    expect((await getSpaceWatch(db, SPACE))?.lastFullReconcileAt).not.toBeNull();
  });

  it("backs off exponentially per writer, capped at an hour", async () => {
    const { db } = await setup();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      const failure = await recordRepoFailure(db, WATCH, BOB, {
        error: "down",
        now: 0,
      });
      delays.push(failure.retryAfter / 60_000);
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it("backs off a failing Space instead of retrying every minute", async () => {
    const { db, engine, serve, connect } = await setup();
    await connect();
    serve({ [ALICE]: xrpcError("RepoDeactivated") });
    const before = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(engine.reconcileSpace(SPACE)).rejects.toMatchObject({
        code: "RepoDeactivated",
      });
      const watch = (await getSpaceWatch(db, SPACE))!;
      // A suspended authority is neither deleted nor an access refusal.
      expect(watch).toMatchObject({
        status: "active",
        consecutiveFailures: attempt,
      });
      expect(watch.nextReconcileAt - before).toBeGreaterThanOrEqual(
        60_000 * 2 ** (attempt - 1),
      );
    }
  });

  it("hides a taken-down writer's records and restores them on reinstatement", async () => {
    const { db, engine, serve, connect, notes } = await setup();
    await connect();
    const bob = { rev: "1", notes: ["from bob"] };
    const carol = { rev: "1", notes: ["from carol"] };
    const hosts = {
      [ALICE]: authority(() => []),
      [BOB]: writerHost(BOB, bob),
      [CAROL]: writerHost(CAROL, carol),
    };
    serve(hosts);
    await engine.syncRepo(SPACE, BOB);
    await engine.syncRepo(SPACE, CAROL);
    expect(await notes()).toEqual(["from bob", "from carol"]);

    serve({ ...hosts, [BOB]: xrpcError("RepoTakendown") });
    await expect(engine.syncRepo(SPACE, BOB)).resolves.toMatchObject({
      outcome: "failed",
    });
    expect(await notes()).toEqual(["from carol"]);
    expect(await getRepoState(db, WATCH, BOB)).toBeNull();
    expect((await getSpaceWatch(db, SPACE))?.status).toBe("active");

    serve(hosts);
    await engine.syncRepo(SPACE, BOB);
    expect(await notes()).toEqual(["from bob", "from carol"]);
    expect(await listRepoFailures(db, WATCH)).toEqual([]);
  });

  it("keeps a deactivated writer's records and does not attempt recovery", async () => {
    const { engine, calls, serve, connect, notes } = await setup();
    await connect();
    const bob = { rev: "1", notes: ["from bob"] };
    serve({ [ALICE]: authority(() => []), [BOB]: writerHost(BOB, bob) });
    await engine.syncRepo(SPACE, BOB);
    calls.length = 0;
    serve({
      [ALICE]: authority(() => []),
      [BOB]: xrpcError("RepoDeactivated"),
    });
    await expect(engine.syncRepo(SPACE, BOB)).resolves.toMatchObject({
      outcome: "failed",
    });
    expect(calls).toEqual(["bob.test:listRepoOps"]);
    expect(await notes()).toEqual(["from bob"]);
  });
});

describe("notification sequencing", () => {
  it("skips applied revisions, advances the checkpoint and reports gaps", async () => {
    const { db, engine, calls, serve, connect } = await setup();
    await connect();
    const bob = { rev: "1", notes: ["from bob"] };
    serve({
      [ALICE]: authority(() => [{ did: BOB, state: bob, spaceRev: "1" }]),
      [BOB]: writerHost(BOB, bob),
    });
    await engine.reconcileSpace(SPACE);
    expect((await getSpaceWatch(db, SPACE))?.spaceRev).toBe("1");

    // A duplicate of an applied revision costs no request at all.
    calls.length = 0;
    await expect(
      engine.syncRepo(SPACE, BOB, {
        rev: "1",
        hash: await commitHash(BOB, bob),
        spaceRev: "2",
        prevSpaceRev: "1",
      }),
    ).resolves.toEqual({ outcome: "unchanged", catchUp: false });
    expect(calls).toEqual([]);
    expect((await getSpaceWatch(db, SPACE))?.spaceRev).toBe("2");

    // Revision 4 never arrived: the checkpoint must not skip over it.
    await expect(
      engine.syncRepo(SPACE, BOB, {
        rev: "1",
        spaceRev: "5",
        prevSpaceRev: "4",
      }),
    ).resolves.toEqual({ outcome: "unchanged", catchUp: true });
    expect((await getSpaceWatch(db, SPACE))?.spaceRev).toBe("2");
  });

  it("never moves the checkpoint backward", async () => {
    const { db } = await setup();
    expect(await advanceSpaceRev(db, WATCH, { spaceRev: "5" })).toBe(true);
    expect(await advanceSpaceRev(db, WATCH, { spaceRev: "3" })).toBe(true);
    expect(
      await advanceSpaceRev(db, WATCH, {
        spaceRev: "4",
        prevSpaceRev: "1",
        contiguousOnly: true,
      }),
    ).toBe(true);
    expect((await getSpaceWatch(db, SPACE))?.spaceRev).toBe("5");
  });

  it("re-reads a host that is behind its own notification", async () => {
    const { db, engine, calls, serve, connect, notes } = await setup();
    await connect();
    const bob = { rev: "1", notes: ["first"] };
    const host = writerHost(BOB, bob);
    let reads = 0;
    serve({
      [ALICE]: authority(() => []),
      [BOB]: (url, request) => {
        // The write lands on the host only after the first re-read.
        if (++reads === 3) Object.assign(bob, { rev: "2", notes: ["second"] });
        return host(url, request);
      },
    });
    await engine.syncRepo(SPACE, BOB);
    calls.length = 0;
    await expect(
      engine.syncRepo(SPACE, BOB, { rev: "2" }),
    ).resolves.toMatchObject({ outcome: "synced" });
    expect(calls.filter((call) => call.endsWith("listRepoOps"))).toHaveLength(
      2,
    );
    expect((await getRepoState(db, WATCH, BOB))?.rev).toBe("2");
    expect(await notes()).toEqual(["second"]);
  });
});

describe("credential renewal", () => {
  const jwt = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const delegation = (userDid: string) =>
    `${jwt({})}.${jwt({
      iss: userDid,
      sub: SPACE,
      exp: Math.floor(Date.now() / 1000) + 60,
    })}.signature`;
  const issuing = (inner: Handler, issued: string[]): Handler => {
    return async (url, request) => {
      if (!url.pathname.endsWith("getSpaceCredential"))
        return inner(url, request);
      const body = (await request.json()) as {
        credentialKid: string;
        delegationToken: string;
      };
      issued.push(body.delegationToken);
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        credential: `${jwt({
          typ: "atproto-space-credential+jwt",
          kid: "#atproto",
        })}.${jwt({
          iss: ALICE,
          sub: SPACE,
          iat: now,
          exp: now + 3600,
          jti: `credential-${issued.length}`,
          cnf: { kid: body.credentialKid },
        })}.signature`,
      });
    };
  };

  it("mints a fresh sync credential without granting anyone read access", async () => {
    const renewCredential = vi.fn(async () => ({
      userDid: BOB,
      delegation: delegation(BOB),
    }));
    const { db, engine, serve, notes } = await setup({ renewCredential });
    const bob = { rev: "1", notes: ["from bob"] };
    const issued: string[] = [];
    serve({
      [ALICE]: issuing(
        authority(() => [{ did: BOB, state: bob, spaceRev: "1" }]),
        issued,
      ),
      [BOB]: writerHost(BOB, bob),
    });
    await engine.reconcileSpace(SPACE);
    expect(renewCredential).toHaveBeenCalledWith({
      spaceUri: SPACE,
      authorityDid: ALICE,
      viewerDid: undefined,
    });
    expect(await notes()).toEqual(["from bob"]);
    expect(issued).toHaveLength(1);
    expect(
      (await loadCredential(db, { ...WATCH, encryptionKey: KEY }))?.viewerDid,
    ).toBe(BOB);
    expect(await hasAccessLease(db, { ...WATCH, userDid: BOB })).toBe(false);

    // A credential with plenty of life left is not renewed again.
    await engine.reconcileSpace(SPACE);
    expect(issued).toHaveLength(1);
  });

  it("pauses when no session can mint, but not when the hook fails", async () => {
    const renewCredential = vi.fn(async () => null);
    const { db, engine, serve } = await setup({ renewCredential });
    serve({ [ALICE]: authority(() => []) });
    await expect(engine.reconcileSpace(SPACE)).rejects.toMatchObject({
      code: "CredentialExpired",
    });
    expect((await getSpaceWatch(db, SPACE))?.status).toBe("paused");

    const failing = await setup({
      renewCredential: async () => {
        throw new Error("session store unavailable");
      },
    });
    failing.serve({ [ALICE]: authority(() => []) });
    await expect(failing.engine.reconcileSpace(SPACE)).rejects.toThrow(
      "session store unavailable",
    );
    expect(await getSpaceWatch(failing.db, SPACE)).toMatchObject({
      status: "active",
      consecutiveFailures: 1,
    });
  });

  it("keeps a still-valid credential when renewal is refused", async () => {
    const { db, engine, serve, notes } = await setup({
      renewCredential: async () => ({
        userDid: CAROL,
        delegation: delegation(CAROL),
      }),
    });
    await saveCredential(db, {
      spaceUri: SPACE,
      generation: 1,
      viewerDid: BOB,
      encryptionKey: KEY,
      credential: await new SpaceCredentialTransport(
        "credential",
        await P256Keypair.create({ exportable: true }),
        Date.now() + 2 * 60_000,
      ).serialize(),
    });
    const bob = { rev: "1", notes: ["from bob"] };
    const inner = authority(() => [{ did: BOB, state: bob, spaceRev: "1" }]);
    serve({
      [ALICE]: (url, request) =>
        url.pathname.endsWith("getSpaceCredential")
          ? Response.json({ error: "SpaceNotFound" }, { status: 400 })
          : inner(url, request),
      [BOB]: writerHost(BOB, bob),
    });
    await engine.reconcileSpace(SPACE);
    expect(await notes()).toEqual(["from bob"]);
    expect((await getSpaceWatch(db, SPACE))?.status).toBe("active");
  });
});
