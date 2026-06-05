import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "@atmo-dev/contrail-base";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { initCommunitySchema } from "../src/schema";
import { CommunityAdapter } from "../src/adapter";
import { CredentialCipher } from "../src/credentials";
import {
  generateKeyPair,
  buildTombstoneOp,
  signTombstoneOp,
  submitTombstoneOp,
  cidForOp,
  type SignedGenesisOp,
} from "../src/plc";
import { runReap, chooseReapDbSource } from "../src/cli/reap";

type SeedStatus =
  | "keys_generated"
  | "genesis_submitted"
  | "account_created"
  | "did_doc_updated"
  | "activated";

interface SeedAttemptOpts {
  attemptId: string;
  did: string;
  status: SeedStatus;
}

async function seedAttempt(
  adapter: CommunityAdapter,
  cipher: CredentialCipher,
  opts: SeedAttemptOpts
): Promise<{ rotationJwk: JsonWebKey }> {
  const kp = await generateKeyPair();
  const encryptedRotation = await cipher.encrypt(JSON.stringify(kp.privateJwk));
  await adapter.createProvisionAttempt({
    attemptId: opts.attemptId,
    did: opts.did,
    pdsEndpoint: "https://pds.test",
    handle: `${opts.attemptId}.pds.test`,
    email: `${opts.attemptId}@x.test`,
    encryptedSigningKey: await cipher.encrypt("{}"),
    encryptedRotationKey: encryptedRotation,
  });
  // Walk the row forward to its target status. The row starts at
  // keys_generated after createProvisionAttempt.
  const path: SeedStatus[] = [
    "genesis_submitted",
    "account_created",
    "did_doc_updated",
    "activated",
  ];
  for (const next of path) {
    if (opts.status === "keys_generated") break;
    await adapter.updateProvisionStatus(opts.attemptId, next);
    if (next === opts.status) break;
  }
  return { rotationJwk: kp.privateJwk };
}

interface PlcCall {
  url: string;
  method: string;
  body: any;
}

/** Stand-in for what PLC's `/log/last` actually returns: the bare signed op
 *  object, no envelope. `getLastOpCid` computes the CID locally via cidForOp. */
const FAKE_LAST_OP: SignedGenesisOp = {
  type: "plc_operation",
  prev: null,
  rotationKeys: ["did:key:zQ3shfakerotation00000000000000000000000000000000000"],
  verificationMethods: { atproto: "did:key:zQ3shfakeverif00000000000000000000000000000000000000" },
  alsoKnownAs: ["at://fixture.pds.test"],
  services: {
    atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://pds.test" },
  },
  sig: "fakesigfakesigfakesigfakesigfakesigfakesigfakesigfakesigfakesigfakesigfakesigfakesigfak",
};

function makeFakeFetch(calls: PlcCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/log/last")) {
      return new Response(JSON.stringify(FAKE_LAST_OP), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response("", { status: 200 });
  }) as typeof fetch;
}

describe("runReap (cli reap)", () => {
  let db: Database;
  let adapter: CommunityAdapter;
  let cipher: CredentialCipher;

  beforeEach(async () => {
    db = createSqliteDatabase(":memory:");
    await initCommunitySchema(db);
    cipher = new CredentialCipher(new Uint8Array(32).fill(7));
    adapter = new CommunityAdapter(db);
  });

  it("rejects when neither --attempt-id nor --all-stuck is set", async () => {
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch([]),
      logger: { log: () => {}, error: () => {} },
      yes: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/--attempt-id|--all-stuck/i);
  });

  it("rejects when both --attempt-id and --all-stuck are set", async () => {
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch([]),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      attemptId: "a1",
      allStuck: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mutually exclusive|both|exactly one/i);
  });

  it("real run with --attempt-id submits a tombstone and archives the row", async () => {
    await seedAttempt(adapter, cipher, {
      attemptId: "a-stuck",
      did: "did:plc:stuck",
      status: "genesis_submitted",
    });

    const calls: PlcCall[] = [];
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch(calls),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      attemptId: "a-stuck",
      dryRun: false,
    });

    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(1);
    expect(result.errors).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://plc.test/did:plc:stuck");
    expect(calls[0]!.body.type).toBe("plc_tombstone");
    expect(calls[0]!.body.prev).toBe(await cidForOp(FAKE_LAST_OP));

    // Original row removed from provision_attempts.
    expect(await adapter.getProvisionAttempt("a-stuck")).toBeNull();
    // Archive row populated with the row's last live status.
    const archive = await db
      .prepare(
        "SELECT * FROM provision_attempts_archive WHERE attempt_id = ?"
      )
      .bind("a-stuck")
      .first<Record<string, any>>();
    expect(archive).not.toBeNull();
    expect(archive!.did).toBe("did:plc:stuck");
    expect(archive!.last_status).toBe("genesis_submitted");
    expect(archive!.tombstone_op_cid).toBeTruthy();
  });

  it("defaults to dry-run when dryRun is unspecified (safety default)", async () => {
    await seedAttempt(adapter, cipher, {
      attemptId: "a-stuck",
      did: "did:plc:stuck",
      status: "did_doc_updated",
    });

    const calls: PlcCall[] = [];
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch(calls),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      attemptId: "a-stuck",
      // dryRun INTENTIONALLY OMITTED — must default to dry-run.
    });

    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(0);
    expect(result.dryRunSkipped).toBe(1);
    expect(calls.length).toBe(0);
    const row = await adapter.getProvisionAttempt("a-stuck");
    expect(row?.status).toBe("did_doc_updated");
  });

  it("with --all-stuck reaps every non-activated row, regardless of status", async () => {
    await seedAttempt(adapter, cipher, {
      attemptId: "s1",
      did: "did:plc:s1",
      status: "keys_generated",
    });
    await seedAttempt(adapter, cipher, {
      attemptId: "s2",
      did: "did:plc:s2",
      status: "genesis_submitted",
    });
    await seedAttempt(adapter, cipher, {
      attemptId: "s3",
      did: "did:plc:s3",
      status: "did_doc_updated",
    });
    // An activated row must NOT be reaped.
    await seedAttempt(adapter, cipher, {
      attemptId: "live",
      did: "did:plc:live",
      status: "activated",
    });

    const calls: PlcCall[] = [];
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch(calls),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      allStuck: true,
      dryRun: false,
      olderThanMs: 0, // these rows are freshly seeded; disable the age floor
    });

    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(3);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://plc.test/did:plc:s1",
      "https://plc.test/did:plc:s2",
      "https://plc.test/did:plc:s3",
    ]);
    // The activated row is untouched.
    const live = await adapter.getProvisionAttempt("live");
    expect(live?.status).toBe("activated");
  });

  it("--all-stuck skips freshly-updated in-flight rows under the default age floor", async () => {
    // A row mid-state-machine (updated_at ~ now) must survive a default
    // --all-stuck run so reap can't tombstone a DID about to activate.
    await seedAttempt(adapter, cipher, {
      attemptId: "in-flight",
      did: "did:plc:inflight",
      status: "genesis_submitted",
    });

    const calls: PlcCall[] = [];
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch(calls),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      allStuck: true,
      dryRun: false,
      // olderThanMs OMITTED — must apply the default 30-min floor.
    });

    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(0);
    expect(calls.length).toBe(0);
    // The in-flight row is untouched.
    expect((await adapter.getProvisionAttempt("in-flight"))?.status).toBe(
      "genesis_submitted"
    );
  });

  it("refuses to reap an activated row passed via --attempt-id", async () => {
    await seedAttempt(adapter, cipher, {
      attemptId: "live",
      did: "did:plc:live",
      status: "activated",
    });

    const calls: PlcCall[] = [];
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch(calls),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      attemptId: "live",
      dryRun: false,
    });

    expect(calls.length).toBe(0);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    const live = await adapter.getProvisionAttempt("live");
    expect(live?.status).toBe("activated");
  });
});

describe("chooseReapDbSource", () => {
  it("selects Postgres when --db is given", () => {
    expect(
      chooseReapDbSource({ db: "postgres://x", databaseUrl: undefined })
    ).toEqual({ kind: "postgres", url: "postgres://x" });
  });

  it("selects Postgres from DATABASE_URL when --db is absent", () => {
    expect(
      chooseReapDbSource({ db: undefined, databaseUrl: "postgres://env" })
    ).toEqual({ kind: "postgres", url: "postgres://env" });
  });

  it("prefers an explicit --db over DATABASE_URL", () => {
    expect(
      chooseReapDbSource({ db: "postgres://flag", databaseUrl: "postgres://env" })
    ).toEqual({ kind: "postgres", url: "postgres://flag" });
  });

  it("falls back to the D1 binding when neither is set", () => {
    expect(chooseReapDbSource({ db: undefined, databaseUrl: undefined })).toEqual({
      kind: "d1",
    });
  });
});

describe("plc tombstone helpers", () => {
  it("signTombstoneOp adds a base64url sig", async () => {
    const kp = await generateKeyPair();
    const op = buildTombstoneOp("bafyreigenesis");
    const signed = await signTombstoneOp(op, kp.privateJwk);
    expect(signed.type).toBe("plc_tombstone");
    expect(signed.prev).toBe("bafyreigenesis");
    expect(signed.sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("submitTombstoneOp POSTs to the PLC directory at the DID URL", async () => {
    const kp = await generateKeyPair();
    const signed = await signTombstoneOp(
      buildTombstoneOp("bafyreigenesis"),
      kp.privateJwk
    );

    let calledUrl = "";
    let calledBody: any = null;
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input);
      calledBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await submitTombstoneOp("https://plc.test", "did:plc:abc", signed, {
      fetch: fakeFetch,
    });
    expect(calledUrl).toBe("https://plc.test/did:plc:abc");
    expect(calledBody.type).toBe("plc_tombstone");
    expect(calledBody.prev).toBe("bafyreigenesis");
    expect(calledBody.sig).toBe(signed.sig);
  });

  it("submitTombstoneOp throws on non-2xx", async () => {
    const kp = await generateKeyPair();
    const signed = await signTombstoneOp(
      buildTombstoneOp("bafyreigenesis"),
      kp.privateJwk
    );
    const fakeFetch: typeof fetch = (async () =>
      new Response("denied", { status: 400 })) as typeof fetch;
    await expect(
      submitTombstoneOp("https://plc.test", "did:plc:abc", signed, {
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/400.*denied/);
  });
});
