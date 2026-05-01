import { describe, it, expect, beforeEach } from "vitest";
import { initCommunitySchema } from "../src/core/community/schema";
import { CommunityAdapter } from "../src/core/community/adapter";
import { CredentialCipher } from "../src/core/community/credentials";
import {
  generateKeyPair,
  buildTombstoneOp,
  signTombstoneOp,
  submitTombstoneOp,
  cidForOp,
  type SignedGenesisOp,
} from "../src/core/community/plc";
import { runReap } from "../src/cli/commands/reap";
import type { Database } from "../src/core/types";
import { createTestDbWithSchema } from "./helpers";

interface SeedAttemptOpts {
  attemptId: string;
  did: string;
  status: "orphaned" | "activated" | "keys_generated";
}

async function seedAttempt(
  db: Database,
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
    callerRotationDidKey: kp.publicDidKey,
  });
  if (opts.status !== "keys_generated") {
    // Walk the row to its target status. We bypass updateProvisionStatus's
    // enum validation by going through it normally — the schema accepts every
    // declared status, so a direct path is fine.
    if (opts.status === "orphaned") {
      await adapter.updateProvisionStatus(opts.attemptId, "genesis_submitted");
      await adapter.updateProvisionStatus(opts.attemptId, "orphaned", {
        lastError: "test fixture",
      });
    } else if (opts.status === "activated") {
      await adapter.updateProvisionStatus(opts.attemptId, "genesis_submitted");
      await adapter.updateProvisionStatus(opts.attemptId, "account_created");
      await adapter.updateProvisionStatus(opts.attemptId, "did_doc_updated");
      await adapter.updateProvisionStatus(opts.attemptId, "activated");
    }
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
    db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    cipher = new CredentialCipher(new Uint8Array(32).fill(7));
    adapter = new CommunityAdapter(db);
  });

  it("rejects when neither --attempt-id nor --all-orphaned is set", async () => {
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch([]),
      logger: { log: () => {}, error: () => {} },
      yes: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/--attempt-id|--all-orphaned/i);
  });

  it("rejects when both --attempt-id and --all-orphaned are set", async () => {
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch([]),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      attemptId: "a1",
      allOrphaned: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mutually exclusive|both|exactly one/i);
  });

  it("dry-run leaves the row unchanged and creates no archive entry", async () => {
    await seedAttempt(db, adapter, cipher, {
      attemptId: "a-orphan",
      did: "did:plc:orphan",
      status: "orphaned",
    });

    const calls: PlcCall[] = [];
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch(calls),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      attemptId: "a-orphan",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(0);
    expect(result.dryRunSkipped).toBe(1);
    // No PLC POST was issued (we ignore log/last in calls list).
    expect(calls.length).toBe(0);
    // Row still in provision_attempts with status=orphaned.
    const row = await adapter.getProvisionAttempt("a-orphan");
    expect(row?.status).toBe("orphaned");
    // No archive row.
    const archive = await db
      .prepare("SELECT * FROM provision_attempts_orphaned_archive WHERE attempt_id = ?")
      .bind("a-orphan")
      .first();
    expect(archive).toBeNull();
  });

  it("real run with --attempt-id submits a tombstone and archives the row", async () => {
    await seedAttempt(db, adapter, cipher, {
      attemptId: "a-orphan",
      did: "did:plc:orphan",
      status: "orphaned",
    });

    const calls: PlcCall[] = [];
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch(calls),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      attemptId: "a-orphan",
      dryRun: false,
    });

    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(1);
    expect(result.errors).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://plc.test/did:plc:orphan");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body.type).toBe("plc_tombstone");
    expect(calls[0]!.body.prev).toBe(await cidForOp(FAKE_LAST_OP));
    expect(typeof calls[0]!.body.sig).toBe("string");

    // Original row removed from provision_attempts.
    const original = await adapter.getProvisionAttempt("a-orphan");
    expect(original).toBeNull();
    // Archive row populated.
    const archive = await db
      .prepare("SELECT * FROM provision_attempts_orphaned_archive WHERE attempt_id = ?")
      .bind("a-orphan")
      .first<Record<string, any>>();
    expect(archive).not.toBeNull();
    expect(archive!.did).toBe("did:plc:orphan");
    expect(archive!.last_status).toBe("orphaned");
    expect(archive!.tombstone_op_cid).toBeTruthy();
    expect(Number(archive!.archived_at)).toBeGreaterThan(0);
  });

  it("with --all-orphaned reaps every orphaned row", async () => {
    await seedAttempt(db, adapter, cipher, {
      attemptId: "o1",
      did: "did:plc:o1",
      status: "orphaned",
    });
    await seedAttempt(db, adapter, cipher, {
      attemptId: "o2",
      did: "did:plc:o2",
      status: "orphaned",
    });
    await seedAttempt(db, adapter, cipher, {
      attemptId: "o3",
      did: "did:plc:o3",
      status: "orphaned",
    });
    // A non-orphaned row should not be reaped.
    await seedAttempt(db, adapter, cipher, {
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
      allOrphaned: true,
      dryRun: false,
    });

    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(3);
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://plc.test/did:plc:o1",
      "https://plc.test/did:plc:o2",
      "https://plc.test/did:plc:o3",
    ]);
    // The activated row is untouched.
    const live = await adapter.getProvisionAttempt("live");
    expect(live?.status).toBe("activated");
  });

  it("defaults to dry-run when dryRun is unspecified (safety default)", async () => {
    await seedAttempt(db, adapter, cipher, {
      attemptId: "a-orphan",
      did: "did:plc:orphan",
      status: "orphaned",
    });

    const calls: PlcCall[] = [];
    const result = await runReap({
      adapter,
      cipher,
      plcDirectory: "https://plc.test",
      fetch: makeFakeFetch(calls),
      logger: { log: () => {}, error: () => {} },
      yes: true,
      attemptId: "a-orphan",
      // dryRun INTENTIONALLY OMITTED — must default to dry-run.
    });

    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(0);
    expect(result.dryRunSkipped).toBe(1);
    expect(calls.length).toBe(0);
    const row = await adapter.getProvisionAttempt("a-orphan");
    expect(row?.status).toBe("orphaned");
  });

  it("refuses to reap a non-orphaned row passed via --attempt-id", async () => {
    await seedAttempt(db, adapter, cipher, {
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
    });

    // Either ok=false OR ok=true with skipped=1+errors>=1; we just assert the row is unchanged.
    expect(calls.length).toBe(0);
    const live = await adapter.getProvisionAttempt("live");
    expect(live?.status).toBe("activated");
    // No archive row.
    const archive = await db
      .prepare("SELECT * FROM provision_attempts_orphaned_archive WHERE attempt_id = ?")
      .bind("live")
      .first();
    expect(archive).toBeNull();
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });
});

describe("plc tombstone helpers", () => {
  it("buildTombstoneOp produces the expected shape", () => {
    const op = buildTombstoneOp("bafyreigenesis");
    expect(op.type).toBe("plc_tombstone");
    expect(op.prev).toBe("bafyreigenesis");
  });

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
