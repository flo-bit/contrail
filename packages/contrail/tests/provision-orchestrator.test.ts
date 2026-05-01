import { describe, it, expect, beforeEach } from "vitest";
import { initCommunitySchema } from "../src/core/community/schema";
import { CommunityAdapter } from "../src/core/community/adapter";
import { CredentialCipher } from "../src/core/community/credentials";
import { ProvisionOrchestrator } from "../src/core/community/provision";
import { generateKeyPair } from "../src/core/community/plc";
import { createTestDbWithSchema } from "./helpers";

function mockPlc(opts: { lastOpCid?: string } = {}) {
  const ops: any[] = [];
  return {
    ops,
    async submit(did: string, op: any) {
      ops.push({ did, op });
      return { ok: true };
    },
    async getLastOpCid(_did: string) {
      return opts.lastOpCid ?? "bafyreistubgenesiscid";
    },
  };
}

function mockPds() {
  return {
    async createAccount() {
      return {
        did: "did:plc:x",
        handle: "h.test",
        accessJwt: "AT",
        refreshJwt: "RT",
      };
    },
    async getRecommendedDidCredentials() {
      return {
        rotationKeys: ["did:key:zPdsRot"],
        verificationMethods: { atproto: "did:key:zPdsSig" },
        alsoKnownAs: ["at://h.test"],
        services: {
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: "https://pds.test",
          },
        },
      };
    },
    async activateAccount() {
      return;
    },
  };
}

describe("ProvisionOrchestrator", () => {
  let adapter: CommunityAdapter;
  let cipher: CredentialCipher;
  beforeEach(async () => {
    const db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    cipher = new CredentialCipher(new Uint8Array(32).fill(99));
    adapter = new CommunityAdapter(db);
  });

  it("runs end-to-end and lands at status=activated", async () => {
    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: mockPlc(),
      pds: mockPds(),
      pdsDid: "did:web:pds.test",
    });

    const result = await orch.provision({
      attemptId: "a1",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: "p",
      inviteCode: "code",
    });

    expect(result.did).toBeTruthy();
    expect(result.status).toBe("activated");
    const row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("activated");
    expect(row?.encryptedSigningKey).toBeTruthy();
    expect(row?.encryptedRotationKey).toBeTruthy();
    expect(row?.encryptedPassword).toBeTruthy();
  });

  it("persists status=genesis_submitted before createAccount runs", async () => {
    let createCalled = false;
    const pds = {
      async createAccount() {
        // Inspect state at this exact moment.
        const row = await adapter.getProvisionAttempt("a1");
        expect(row?.status).toBe("genesis_submitted");
        createCalled = true;
        return {
          did: "did:plc:x",
          handle: "h.test",
          accessJwt: "AT",
          refreshJwt: "RT",
        };
      },
      async getRecommendedDidCredentials() {
        return {
          rotationKeys: [],
          verificationMethods: { atproto: "did:key:zSig" },
          alsoKnownAs: ["at://h.test"],
          services: {
            atproto_pds: { type: "x", endpoint: "https://pds.test" },
          },
        };
      },
      async activateAccount() {},
    };

    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: mockPlc(),
      pds,
      pdsDid: "did:web:pds.test",
    });
    await orch.provision({
      attemptId: "a1",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: "p",
    });
    expect(createCalled).toBe(true);
  });

  it("marks last_error and rethrows when createAccount fails", async () => {
    const pds = {
      ...mockPds(),
      async createAccount() {
        throw new Error("createAccount 400: bad invite");
      },
    } as any;

    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: mockPlc(),
      pds,
      pdsDid: "did:web:pds.test",
    });

    await expect(
      orch.provision({
        attemptId: "a1",
        pdsEndpoint: "https://pds.test",
        handle: "h.test",
        email: "h@x.test",
        password: "p",
      })
    ).rejects.toThrow(/bad invite/);
    const row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("genesis_submitted"); // last successful step
    expect(row?.lastError).toMatch(/bad invite/);
  });

  it("resumeFromAccountCreated submits an update op with prev=PLC log/last cid and lands at activated", async () => {
    // Pre-create a row at status=account_created with a real encrypted rotation key,
    // simulating recovery from a crash after createAccount succeeded.
    const rotationKey = await generateKeyPair();
    const encryptedRotation = await cipher.encrypt(
      JSON.stringify(rotationKey.privateJwk)
    );
    const encryptedSigning = await cipher.encrypt(JSON.stringify({}));
    await adapter.createProvisionAttempt({
      attemptId: "a1",
      did: "did:plc:x",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      encryptedSigningKey: encryptedSigning,
      encryptedRotationKey: encryptedRotation,
    });
    await adapter.updateProvisionStatus("a1", "genesis_submitted");
    await adapter.updateProvisionStatus("a1", "account_created", {
      encryptedPassword: await cipher.encrypt("p"),
    });

    const stubCid = "bafyreitestcid";
    const plc = mockPlc({ lastOpCid: stubCid });
    let activateCalled = false;
    const pds = {
      async createAccount() {
        throw new Error("should not be called on resume");
      },
      async getRecommendedDidCredentials() {
        return {
          rotationKeys: ["did:key:zPdsRot"],
          verificationMethods: { atproto: "did:key:zPdsSig" },
          alsoKnownAs: ["at://h.test"],
          services: {
            atproto_pds: {
              type: "AtprotoPersonalDataServer",
              endpoint: "https://pds.test",
            },
          },
        };
      },
      async activateAccount(input: { pdsUrl: string; accessJwt: string }) {
        expect(input.accessJwt).toBe("AT");
        activateCalled = true;
      },
    };

    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc,
      pds,
      pdsDid: "did:web:pds.test",
    });

    await orch.resumeFromAccountCreated("a1", "AT");

    // Verify the update op was submitted with prev = the cid we mocked.
    expect(plc.ops).toHaveLength(1);
    const submitted = plc.ops[0];
    expect(submitted.did).toBe("did:plc:x");
    expect(submitted.op.type).toBe("plc_operation");
    expect(submitted.op.prev).toBe(stubCid);
    // The signed update must merge the rotation key we stored with the recommended one.
    expect(submitted.op.rotationKeys).toContain(rotationKey.publicDidKey);
    expect(submitted.op.rotationKeys).toContain("did:key:zPdsRot");

    expect(activateCalled).toBe(true);
    const row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("activated");
    expect(row?.activatedAt).toBeTruthy();
  });
});
