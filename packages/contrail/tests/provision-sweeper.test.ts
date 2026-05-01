import { describe, it, expect, beforeEach } from "vitest";
import { initCommunitySchema } from "../src/core/community/schema";
import { CommunityAdapter } from "../src/core/community/adapter";
import { CredentialCipher } from "../src/core/community/credentials";
import { ProvisionSweeper } from "../src/core/community/provision-sweeper";
import { createTestDbWithSchema } from "./helpers";

describe("ProvisionSweeper", () => {
  let adapter: CommunityAdapter;
  let cipher: CredentialCipher;

  beforeEach(async () => {
    const db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    cipher = new CredentialCipher(new Uint8Array(32).fill(99));
    adapter = new CommunityAdapter(db);
  });

  it("marks orphaned when createSession returns 401", async () => {
    await adapter.createProvisionAttempt({
      attemptId: "a1",
      did: "did:plc:x",
      pdsEndpoint: "https://pds.test",
      handle: "x.pds.test",
      email: "x@x.test",
      encryptedSigningKey: await cipher.encrypt("{}"),
      encryptedRotationKey: await cipher.encrypt("{}"),
    });
    await adapter.updateProvisionStatus("a1", "genesis_submitted", {
      encryptedPassword: await cipher.encrypt("p"),
    });

    const sweeper = new ProvisionSweeper({
      adapter,
      cipher,
      pds: {
        async createSession() {
          return null; // simulates 401
        },
      } as any,
      orchestrator: {} as any,
    });

    await sweeper.sweep({ stuckMs: 0 });
    const row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("orphaned");
    expect(row?.lastError).toMatch(/createSession.*401|orphaned/i);
  });

  it("resumes from step 3 when createSession returns 200 deactivated", async () => {
    await adapter.createProvisionAttempt({
      attemptId: "a1",
      did: "did:plc:x",
      pdsEndpoint: "https://pds.test",
      handle: "x.pds.test",
      email: "x@x.test",
      encryptedSigningKey: await cipher.encrypt("{}"),
      encryptedRotationKey: await cipher.encrypt("{}"),
    });
    await adapter.updateProvisionStatus("a1", "genesis_submitted", {
      encryptedPassword: await cipher.encrypt("p"),
    });

    let resumeCalled = false;
    const orchestrator = {
      async resumeFromAccountCreated(attemptId: string, accessJwt: string) {
        expect(attemptId).toBe("a1");
        expect(accessJwt).toBe("AT");
        resumeCalled = true;
        await adapter.updateProvisionStatus(attemptId, "activated");
      },
    } as any;

    const sweeper = new ProvisionSweeper({
      adapter,
      cipher,
      pds: {
        async createSession() {
          return {
            did: "did:plc:x",
            handle: "x.pds.test",
            accessJwt: "AT",
            refreshJwt: "RT",
            active: false,
            status: "deactivated",
          };
        },
      } as any,
      orchestrator,
    });

    await sweeper.sweep({ stuckMs: 0 });
    expect(resumeCalled).toBe(true);
  });
});
