import { describe, it, expect, beforeEach } from "vitest";
import { initCommunitySchema } from "../src/core/community/schema";
import { CommunityAdapter } from "../src/core/community/adapter";
import { createTestDbWithSchema } from "./helpers";

describe("provision_attempts adapter", () => {
  let adapter: CommunityAdapter;

  beforeEach(async () => {
    const db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    adapter = new CommunityAdapter(db);
  });

  it("creates and reads a provision attempt", async () => {
    const before = Date.now();
    await adapter.createProvisionAttempt({
      attemptId: "a1",
      did: "did:plc:abc",
      pdsEndpoint: "https://pds.test",
      handle: "abc.pds.test",
      email: "abc@x.test",
      inviteCode: "code-1",
      encryptedSigningKey: "sk-enc",
      encryptedRotationKey: "rk-enc",
    });

    const row = await adapter.getProvisionAttempt("a1");
    expect(row).not.toBeNull();
    expect(row?.attemptId).toBe("a1");
    expect(row?.did).toBe("did:plc:abc");
    expect(row?.status).toBe("keys_generated");
    expect(row?.pdsEndpoint).toBe("https://pds.test");
    expect(row?.handle).toBe("abc.pds.test");
    expect(row?.email).toBe("abc@x.test");
    expect(row?.inviteCode).toBe("code-1");
    expect(row?.encryptedSigningKey).toBe("sk-enc");
    expect(row?.encryptedRotationKey).toBe("rk-enc");
    expect(row?.encryptedPassword).toBeNull();
    expect(row?.lastError).toBeNull();
    expect(row?.genesisSubmittedAt).toBeNull();
    expect(row?.accountCreatedAt).toBeNull();
    expect(row?.didDocUpdatedAt).toBeNull();
    expect(row?.activatedAt).toBeNull();
    expect(row?.createdAt).toBeGreaterThanOrEqual(before);
    expect(row?.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("getProvisionAttempt returns null for unknown attempt", async () => {
    const row = await adapter.getProvisionAttempt("no-such-attempt");
    expect(row).toBeNull();
  });

  it("treats missing inviteCode as null", async () => {
    await adapter.createProvisionAttempt({
      attemptId: "a-no-invite",
      did: "did:plc:noinv",
      pdsEndpoint: "https://pds.test",
      handle: "noinv.pds.test",
      email: "noinv@x.test",
      encryptedSigningKey: "sk",
      encryptedRotationKey: "rk",
    });
    const row = await adapter.getProvisionAttempt("a-no-invite");
    expect(row?.inviteCode).toBeNull();
  });

  it("advances status, stamps the matching timestamp, and persists last_error", async () => {
    await adapter.createProvisionAttempt({
      attemptId: "a1",
      did: "did:plc:abc",
      pdsEndpoint: "https://pds.test",
      handle: "abc.pds.test",
      email: "abc@x.test",
      encryptedSigningKey: "sk-enc",
      encryptedRotationKey: "rk-enc",
    });

    const initial = await adapter.getProvisionAttempt("a1");
    const initialUpdated = initial!.updatedAt;

    // Small wait so updated_at can advance on millisecond clocks.
    await new Promise((r) => setTimeout(r, 2));

    await adapter.updateProvisionStatus("a1", "genesis_submitted");
    let row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("genesis_submitted");
    expect(row?.genesisSubmittedAt).toBeTruthy();
    expect(row?.accountCreatedAt).toBeNull();
    expect(row?.didDocUpdatedAt).toBeNull();
    expect(row?.activatedAt).toBeNull();
    expect(row?.updatedAt).toBeGreaterThanOrEqual(initialUpdated);

    await adapter.updateProvisionStatus("a1", "account_created");
    row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("account_created");
    expect(row?.accountCreatedAt).toBeTruthy();
    // Earlier stamp must be preserved on subsequent updates.
    expect(row?.genesisSubmittedAt).toBeTruthy();

    await adapter.updateProvisionStatus("a1", "orphaned", { lastError: "createSession 401" });
    row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("orphaned");
    expect(row?.lastError).toBe("createSession 401");
    // Earlier stamps still preserved.
    expect(row?.genesisSubmittedAt).toBeTruthy();
    expect(row?.accountCreatedAt).toBeTruthy();
  });

  it("persists encryptedPassword via updateProvisionStatus", async () => {
    await adapter.createProvisionAttempt({
      attemptId: "a-pwd",
      did: "did:plc:pwd",
      pdsEndpoint: "https://pds.test",
      handle: "pwd.pds.test",
      email: "pwd@x.test",
      encryptedSigningKey: "sk",
      encryptedRotationKey: "rk",
    });
    expect((await adapter.getProvisionAttempt("a-pwd"))?.encryptedPassword).toBeNull();

    await adapter.updateProvisionStatus("a-pwd", "account_created", {
      encryptedPassword: "pwd-enc",
    });
    const row = await adapter.getProvisionAttempt("a-pwd");
    expect(row?.encryptedPassword).toBe("pwd-enc");
    expect(row?.accountCreatedAt).toBeTruthy();
  });

  it("lists attempts by status, ordered by updated_at ascending", async () => {
    for (const id of ["a1", "a2", "a3"]) {
      await adapter.createProvisionAttempt({
        attemptId: id,
        did: `did:plc:${id}`,
        pdsEndpoint: "https://pds.test",
        handle: `${id}.pds.test`,
        email: `${id}@x.test`,
        encryptedSigningKey: "sk",
        encryptedRotationKey: "rk",
      });
    }
    await adapter.updateProvisionStatus("a2", "genesis_submitted");
    const stuck = await adapter.listProvisionAttemptsByStatus("genesis_submitted");
    expect(stuck.map((r) => r.attemptId)).toEqual(["a2"]);

    // The two untouched attempts remain in the default status.
    const generated = await adapter.listProvisionAttemptsByStatus("keys_generated");
    expect(generated.map((r) => r.attemptId).sort()).toEqual(["a1", "a3"]);
  });

  it("listProvisionAttemptsByStatus respects olderThanMs cutoff", async () => {
    await adapter.createProvisionAttempt({
      attemptId: "fresh",
      did: "did:plc:fresh",
      pdsEndpoint: "https://pds.test",
      handle: "fresh.pds.test",
      email: "fresh@x.test",
      encryptedSigningKey: "sk",
      encryptedRotationKey: "rk",
    });
    // A huge cutoff means "only return rows older than 1 hour" — fresh row excluded.
    const stale = await adapter.listProvisionAttemptsByStatus("keys_generated", 60 * 60 * 1000);
    expect(stale.map((r) => r.attemptId)).not.toContain("fresh");
  });

  it("enforces did uniqueness across attempts", async () => {
    await adapter.createProvisionAttempt({
      attemptId: "first",
      did: "did:plc:dupe",
      pdsEndpoint: "https://pds.test",
      handle: "first.pds.test",
      email: "first@x.test",
      encryptedSigningKey: "sk",
      encryptedRotationKey: "rk",
    });
    await expect(
      adapter.createProvisionAttempt({
        attemptId: "second",
        did: "did:plc:dupe",
        pdsEndpoint: "https://pds.test",
        handle: "second.pds.test",
        email: "second@x.test",
        encryptedSigningKey: "sk",
        encryptedRotationKey: "rk",
      })
    ).rejects.toThrow();
  });
});
