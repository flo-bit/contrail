import { describe, it, expect, beforeEach } from "vitest";
import { initCommunitySchema } from "../src/schema";
import { CommunityAdapter } from "../src/adapter";
import { CredentialCipher } from "../src/credentials";
import { ProvisionOrchestrator } from "../src/provision";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";

const STUB_ROTATION_KEY = "did:key:zStubCallerRotationKeyForTests";

function mockPlc() {
  const ops: any[] = [];
  return {
    ops,
    async submit(did: string, op: any) {
      ops.push({ did, op });
      return { ok: true };
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
    async createAppPassword() {
      return { password: "minted-app-pw" };
    },
  };
}

describe("ProvisionOrchestrator", () => {
  let adapter: CommunityAdapter;
  let cipher: CredentialCipher;
  beforeEach(async () => {
    const db = createSqliteDatabase(":memory:");
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
      rotationKey: STUB_ROTATION_KEY,
    });

    expect(result.did).toBeTruthy();
    expect(result.status).toBe("activated");
    const row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("activated");
    expect(row?.encryptedSigningKey).toBeTruthy();
    expect(row?.encryptedRotationKey).toBeTruthy();
    expect(row?.encryptedPassword).toBeTruthy();
  });

  it("seeds the community_sessions cache with the createAccount JWTs after activation", async () => {
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
      rotationKey: STUB_ROTATION_KEY,
    });

    const cached = await adapter.getSession(result.did);
    expect(cached).not.toBeNull();
    expect(cached?.accessJwt).toBe("AT");
    expect(cached?.refreshJwt).toBe("RT");
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
      async createAppPassword() {
        return { password: "minted" };
      },
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
      rotationKey: STUB_ROTATION_KEY,
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
        rotationKey: STUB_ROTATION_KEY,
      })
    ).rejects.toThrow(/bad invite/);
    const row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("genesis_submitted"); // last successful step
    expect(row?.lastError).toMatch(/bad invite/);
  });

  it("re-invoking with the same attemptId on a fully-completed row returns success without redoing PLC/PDS work", async () => {
    // Scenario: the orchestrator finished cleanly (status=activated +
    // encryptedPassword set), but a *downstream* step (router's
    // createFromProvisioned or bootstrapReservedSpaces) failed and the
    // caller retries with the same attemptId. The orchestrator must not
    // throw "already exists" — it should report success so the route can
    // resume the graduation steps.
    const plc = mockPlc();
    const pds: any = mockPds();
    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc,
      pds,
      pdsDid: "did:web:pds.test",
    });

    const first = await orch.provision({
      attemptId: "a1",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: "p",
      inviteCode: "code",
      rotationKey: STUB_ROTATION_KEY,
    });
    expect(first.status).toBe("activated");
    const opsAfterFirst = plc.ops.length;

    // Wire a fresh PDS mock whose every method throws — if the retry path
    // calls any of them, the test fails loudly. createSession is allowed
    // because the C3 retry path is wired for the not-yet-completed case;
    // a fully-completed row should NOT hit it either.
    const explodingPds: any = {
      createAccount: () => { throw new Error("createAccount should not be called on a completed retry"); },
      getRecommendedDidCredentials: () => { throw new Error("getRecommendedDidCredentials should not be called"); },
      activateAccount: () => { throw new Error("activateAccount should not be called"); },
      createAppPassword: () => { throw new Error("createAppPassword should not be called on a completed retry"); },
      createSession: () => { throw new Error("createSession should not be called on a completed retry"); },
    };
    const retryOrch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: { submit: () => { throw new Error("plc.submit should not be called on a completed retry"); } },
      pds: explodingPds,
      pdsDid: "did:web:pds.test",
    });

    const second = await retryOrch.provision({
      attemptId: "a1",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: "p",
      inviteCode: "code",
      rotationKey: STUB_ROTATION_KEY,
    });
    expect(second.status).toBe("activated");
    expect(second.did).toBe(first.did);
    expect(second.attemptId).toBe("a1");
    expect(plc.ops.length).toBe(opsAfterFirst);
  });

});
