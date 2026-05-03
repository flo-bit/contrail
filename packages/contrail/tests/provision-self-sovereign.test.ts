import { describe, it, expect, beforeEach } from "vitest";
import { initCommunitySchema } from "../src/core/community/schema";
import { CommunityAdapter } from "../src/core/community/adapter";
import { CredentialCipher } from "../src/core/community/credentials";
import { ProvisionOrchestrator } from "../src/core/community/provision";
import { generateKeyPair } from "../src/core/community/plc";
import { createTestDbWithSchema } from "./helpers";

/** Mock PLC client that records every submitted op so tests can inspect the
 *  genesis op (in particular, its rotationKeys array). */
function mockPlc(opts: { lastOpCid?: string } = {}) {
  const ops: Array<{ did: string; op: any }> = [];
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

/** Mock PDS client that records calls to createAppPassword so tests can assert
 *  on its arguments (or its absence). The minted password is deterministic so
 *  decryption assertions can compare. */
function mockPds(opts: { mintedPassword?: string } = {}) {
  const calls: { createAppPassword: Array<{ pdsUrl: string; accessJwt: string; name: string }> } = {
    createAppPassword: [],
  };
  return {
    calls,
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
    async createAppPassword(input: { pdsUrl: string; accessJwt: string; name: string }) {
      calls.createAppPassword.push(input);
      return { password: opts.mintedPassword ?? "minted-app-pass-XXXX" };
    },
  };
}

describe("ProvisionOrchestrator — caller-supplied rotation key", () => {
  let adapter: CommunityAdapter;
  let cipher: CredentialCipher;
  beforeEach(async () => {
    const db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    cipher = new CredentialCipher(new Uint8Array(32).fill(99));
    adapter = new CommunityAdapter(db);
  });

  it("genesis includes caller rotation key, mints app password, response carries rootCredentials", async () => {
    const callerKeyPair = await generateKeyPair();
    const callerRotationDidKey = callerKeyPair.publicDidKey;
    const userPassword = "user-supplied-root-pw";
    const mintedPassword = "minted-app-pw-1234";

    const plc = mockPlc();
    const pds = mockPds({ mintedPassword });

    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc,
      pds,
      pdsDid: "did:web:pds.test",
    });

    const result = await orch.provision({
      attemptId: "ss1",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: userPassword,
      inviteCode: "code",
      rotationKey: callerRotationDidKey,
    });

    // Status unchanged in shape.
    expect(result.status).toBe("activated");
    expect(result.did).toBeTruthy();

    // Response carries root credentials so the caller can keep their root password.
    expect(result.rootCredentials).toBeDefined();
    expect(result.rootCredentials!.password).toBe(userPassword);
    expect(result.rootCredentials!.handle).toBe("h.test");
    expect(typeof result.rootCredentials!.recoveryHint).toBe("string");

    // Persisted attempt row reaches activated status.
    const row = await adapter.getProvisionAttempt("ss1");
    expect(row).toBeTruthy();
    expect(row!.status).toBe("activated");

    // Genesis op submitted to PLC has BOTH rotation keys, with the caller's first.
    expect(plc.ops.length).toBeGreaterThanOrEqual(1);
    const genesis = plc.ops[0]!.op;
    expect(Array.isArray(genesis.rotationKeys)).toBe(true);
    expect(genesis.rotationKeys[0]).toBe(callerRotationDidKey);
    expect(genesis.rotationKeys.length).toBe(2);
    expect(genesis.rotationKeys[1]).toBeTruthy();
    expect(genesis.rotationKeys[1]).not.toBe(callerRotationDidKey);

    // createAppPassword was invoked post-activation with the session's accessJwt.
    expect(pds.calls.createAppPassword.length).toBe(1);
    const apCall = pds.calls.createAppPassword[0]!;
    expect(apCall.pdsUrl).toBe("https://pds.test");
    expect(apCall.accessJwt).toBe("AT");
    expect(apCall.name).toContain("ss1");

    // encrypted_password column re-decrypts to the MINTED app password,
    // not the user's supplied password.
    expect(row!.encryptedPassword).toBeTruthy();
    const decryptedPw = await cipher.decryptString(row!.encryptedPassword!);
    expect(decryptedPw).toBe(mintedPassword);
    expect(decryptedPw).not.toBe(userPassword);

    // Subordinate rotation private JWK persisted in encrypted_rotation_key
    // must NOT decrypt to anything containing the caller's did:key fingerprint.
    expect(row!.encryptedRotationKey).toBeTruthy();
    const decryptedRot = await cipher.decryptString(row!.encryptedRotationKey!);
    expect(decryptedRot).not.toContain(callerRotationDidKey);

    // Negative invariant: caller's did:key must not appear in any encrypted
    // column (after decryption).
    const encryptedSigning = row!.encryptedSigningKey;
    if (encryptedSigning) {
      const decryptedSig = await cipher.decryptString(encryptedSigning);
      expect(decryptedSig).not.toContain(callerRotationDidKey);
    }
  });

  it("PLC update op preserves caller's rotation key at index 0", async () => {
    // H2 regression guard. The update op (plc.ops[1]) must keep the caller's
    // did:key as rotationKeys[0]. Without threading it through
    // runUpdateAndActivate, the caller's key is dropped and Contrail's
    // subordinate becomes the highest-priority rotation key — caller has 72h
    // to nullify before losing rotation authority on a DID they own.
    const callerKeyPair = await generateKeyPair();
    const callerRotationDidKey = callerKeyPair.publicDidKey;

    const plc = mockPlc();
    const pds = mockPds();

    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc,
      pds,
      pdsDid: "did:web:pds.test",
    });

    await orch.provision({
      attemptId: "ss-update",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: "pw",
      inviteCode: "code",
      rotationKey: callerRotationDidKey,
    });

    // Genesis op already asserted in the prior test; here we focus on the update op.
    expect(plc.ops.length).toBeGreaterThanOrEqual(2);
    const update = plc.ops[1]!.op;
    expect(Array.isArray(update.rotationKeys)).toBe(true);
    expect(update.rotationKeys[0]).toBe(callerRotationDidKey);
    // Contrail's subordinate must remain in the chain (we still need to sign
    // future update ops).
    expect(update.rotationKeys.length).toBeGreaterThanOrEqual(2);
    expect(update.rotationKeys.slice(1)).not.toContain(callerRotationDidKey);
    // PDS-recommended key is merged in after the contrail subordinate.
    expect(update.rotationKeys).toContain("did:key:zPdsRot");
  });

  it("createAppPassword failure persists last_error at status=activated and throws (no encryptedPassword)", async () => {
    const callerKeyPair = await generateKeyPair();
    const plc = mockPlc();
    const pds = {
      ...mockPds(),
      async createAppPassword(_: any) {
        throw new Error("PDS rejected: rate limited");
      },
    };

    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc,
      pds: pds as any,
      pdsDid: "did:web:pds.test",
    });

    await expect(
      orch.provision({
        attemptId: "ss-fail",
        pdsEndpoint: "https://pds.test",
        handle: "h.test",
        email: "h@x.test",
        password: "pw",
        rotationKey: callerKeyPair.publicDidKey,
      })
    ).rejects.toThrow(/createAppPassword/);

    const row = await adapter.getProvisionAttempt("ss-fail");
    expect(row).toBeTruthy();
    expect(row!.status).toBe("activated");
    expect(row!.encryptedPassword).toBeFalsy();
    expect(row!.lastError).toMatch(/createAppPassword/);
  });

  it("retry with same attemptId after createAppPassword failure picks up at createAppPassword (no re-mint, no re-createAccount)", async () => {
    // Simulate the failure-then-retry shape: a first provision call got all
    // the way to createAppPassword and failed; the caller retries with the
    // same attemptId. The orchestrator must NOT re-submit PLC ops, NOT
    // re-call createAccount, only run createAppPassword.
    const callerKeyPair = await generateKeyPair();
    const callerDidKey = callerKeyPair.publicDidKey;
    const mintedPassword = "minted-on-retry-99";

    // First attempt: createAppPassword throws; everything else succeeds.
    const firstPds = {
      ...mockPds(),
      async createAppPassword(_: any) {
        throw new Error("PDS transient: 503");
      },
    };
    const firstPlc = mockPlc();
    const firstOrch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: firstPlc,
      pds: firstPlc && (firstPds as any),
      pdsDid: "did:web:pds.test",
    });
    await expect(
      firstOrch.provision({
        attemptId: "ss-retry",
        pdsEndpoint: "https://pds.test",
        handle: "h.test",
        email: "h@x.test",
        password: "user-root-pw",
        rotationKey: callerDidKey,
      })
    ).rejects.toThrow();

    // Sanity: row is in the failure state we expect.
    const failRow = await adapter.getProvisionAttempt("ss-retry");
    expect(failRow!.status).toBe("activated");
    expect(failRow!.encryptedPassword).toBeFalsy();
    expect(firstPlc.ops.length).toBe(2); // genesis + update

    // Second attempt with the SAME attemptId. Use a fresh mock that would
    // EXPLODE if createAccount or any PLC op was re-issued.
    const retryPlc = {
      ops: [] as Array<{ did: string; op: any }>,
      async submit(_did: string, _op: any) {
        throw new Error("retry must not re-submit PLC ops");
      },
      async getLastOpCid() {
        return "bafyretryguard";
      },
    };
    const retryAppPasswordCalls: any[] = [];
    const retryPds = {
      async createAccount() {
        throw new Error("retry must not re-call createAccount");
      },
      async getRecommendedDidCredentials() {
        throw new Error("retry must not re-fetch recommended creds");
      },
      async activateAccount() {
        throw new Error("retry must not re-activate");
      },
      async createAppPassword(input: any) {
        retryAppPasswordCalls.push(input);
        return { password: mintedPassword };
      },
      async createSession(input: { pdsUrl: string; identifier: string; password: string }) {
        // Verify the retry uses the user's root password to obtain a fresh
        // accessJwt (the cached one from the failed attempt may have expired).
        expect(input.password).toBe("user-root-pw");
        return { accessJwt: "AT-fresh", refreshJwt: "RT-fresh", did: "did:plc:x" };
      },
    };
    const retryOrch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: retryPlc as any,
      pds: retryPds as any,
      pdsDid: "did:web:pds.test",
    });

    const result = await retryOrch.provision({
      attemptId: "ss-retry",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: "user-root-pw",
      rotationKey: callerDidKey,
    });

    // Retry succeeded.
    expect(result.status).toBe("activated");
    expect(result.did).toBe(failRow!.did); // SAME DID, not a new one
    expect(result.rootCredentials).toBeDefined();
    expect(retryAppPasswordCalls.length).toBe(1);

    // Row now has the encrypted (minted) password.
    const finalRow = await adapter.getProvisionAttempt("ss-retry");
    expect(finalRow!.status).toBe("activated");
    expect(finalRow!.encryptedPassword).toBeTruthy();
    const decrypted = await cipher.decryptString(finalRow!.encryptedPassword!);
    expect(decrypted).toBe(mintedPassword);
  });

  it("rejects rotationKey that is not did:key:z…", async () => {
    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: mockPlc(),
      pds: mockPds(),
      pdsDid: "did:web:pds.test",
    });

    await expect(
      orch.provision({
        attemptId: "bad1",
        pdsEndpoint: "https://pds.test",
        handle: "h.test",
        email: "h@x.test",
        password: "p",
        rotationKey: "not-a-did-key",
      })
    ).rejects.toThrow(/rotationKey/);
  });
});
