import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "@atmo-dev/contrail-base";
import { initCommunitySchema } from "../src/schema";
import { CommunityAdapter } from "../src/adapter";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";

describe("provision_attempts adapter", () => {
  let db: Database;
  let adapter: CommunityAdapter;

  beforeEach(async () => {
    db = createSqliteDatabase(":memory:");
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

    await adapter.updateProvisionStatus("a1", "did_doc_updated", { lastError: "transient PLC error" });
    row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("did_doc_updated");
    expect(row?.lastError).toBe("transient PLC error");
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

  describe("listStuckAttempts age threshold", () => {
    async function seedStuck(attemptId: string, did: string): Promise<void> {
      await adapter.createProvisionAttempt({
        attemptId,
        did,
        pdsEndpoint: "https://pds.test",
        handle: `${attemptId}.pds.test`,
        email: `${attemptId}@x.test`,
        encryptedSigningKey: "sk",
        encryptedRotationKey: "rk",
      });
    }
    /** Backdate a row's updated_at so it looks old to the age filter. */
    async function ageRow(attemptId: string, ageMs: number): Promise<void> {
      await db
        .prepare(`UPDATE provision_attempts SET updated_at = ? WHERE attempt_id = ?`)
        .bind(Date.now() - ageMs, attemptId)
        .run();
    }

    it("excludes a freshly-updated (in-flight) non-activated row", async () => {
      await seedStuck("fresh", "did:plc:fresh");
      // updated_at is ~now; a 30-minute floor must not select it.
      const rows = await adapter.listStuckAttempts(30 * 60 * 1000);
      expect(rows.map((r) => r.attemptId)).not.toContain("fresh");
    });

    it("includes a row older than the threshold", async () => {
      await seedStuck("old", "did:plc:old");
      await ageRow("old", 2 * 60 * 60 * 1000); // 2 hours ago
      const rows = await adapter.listStuckAttempts(30 * 60 * 1000);
      expect(rows.map((r) => r.attemptId)).toContain("old");
    });

    it("with a zero threshold returns every non-activated row", async () => {
      await seedStuck("a", "did:plc:a");
      await seedStuck("b", "did:plc:b");
      const rows = await adapter.listStuckAttempts(0);
      expect(rows.map((r) => r.attemptId).sort()).toEqual(["a", "b"]);
    });
  });

  describe("archiveStuckAttempt idempotency", () => {
    it("retry after a partial failure (archive row already present, live row stranded) does not throw and finishes the move", async () => {
      await adapter.createProvisionAttempt({
        attemptId: "partial",
        did: "did:plc:partial",
        pdsEndpoint: "https://pds.test",
        handle: "partial.pds.test",
        email: "partial@x.test",
        encryptedSigningKey: "sk",
        encryptedRotationKey: "rk",
      });
      // Simulate the first reap: its archive INSERT landed, but the live-row
      // DELETE failed, leaving the row in BOTH tables.
      await db
        .prepare(
          `INSERT INTO provision_attempts_archive
            (attempt_id, did, pds_endpoint, handle, email, invite_code,
             last_status, last_error, archived_at, tombstone_op_cid, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "partial",
          "did:plc:partial",
          "https://pds.test",
          "partial.pds.test",
          "partial@x.test",
          null,
          "genesis_submitted",
          null,
          Date.now(),
          "cid-first",
          null
        )
        .run();

      // The retry must not hit a PRIMARY KEY conflict on the archive INSERT.
      await expect(
        adapter.archiveStuckAttempt("partial", { tombstoneOpCid: "cid-retry" })
      ).resolves.toBeUndefined();

      // Live row is now gone; the archive row remains (the original landed copy).
      expect(await adapter.getProvisionAttempt("partial")).toBeNull();
      const archive = await db
        .prepare("SELECT * FROM provision_attempts_archive WHERE attempt_id = ?")
        .bind("partial")
        .first<Record<string, any>>();
      expect(archive).not.toBeNull();
      expect(archive!.tombstone_op_cid).toBe("cid-first");
    });
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
