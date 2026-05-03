/**
 * Devnet e2e for the tombstone CID derivation used by `contrail reap` (M6).
 *
 * `cli/commands/reap.ts:146` calls `cidForOp(signed as never)` because the
 * helper's declared signed-op union covers genesis/update — not tombstone.
 * The DAG-CBOR encoder accepts the smaller tombstone shape, but no other
 * test submits a *real* tombstone to live PLC and verifies the CID we
 * computed locally matches the one PLC returns from `log/last`. This test
 * closes that gap.
 *
 * The test uses managed-mode provisioning to land a real DID on devnet PLC
 * with the rotation key encrypted on the persisted row, then drives the
 * tombstone flow (build → sign → cidForOp → submit) with the same helpers
 * runReap uses, and asserts the post-submit `log/last` matches.
 *
 * Tombstones are irrevocable on PLC. This test always operates on a freshly-
 * provisioned devnet DID never seen by any other test or user.
 *
 * Prereqs: `pnpm stack:up` (devnet PDS+PLC + postgres reachable).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  CommunityAdapter,
  CredentialCipher,
  ProvisionOrchestrator,
  generateKeyPair,
  initCommunitySchema,
  pdsCreateAccount,
  pdsGetRecommendedDidCredentials,
  pdsActivateAccount,
  pdsCreateAppPassword,
  submitGenesisOp,
  getLastOpCid,
  buildTombstoneOp,
  signTombstoneOp,
  submitTombstoneOp,
  cidForOp,
  type PdsClient,
  type PlcClient,
} from "@atmo-dev/contrail";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import {
  PDS_URL,
  PLC_URL,
  HANDLE_DOMAIN,
  PDS_ADMIN_PASSWORD,
  createIsolatedSchema,
} from "./helpers";

describe("reap tombstone CID matches live PLC log/last (M6)", () => {
  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let adapter: CommunityAdapter;
  let cipher: CredentialCipher;
  let pdsDid: string;

  beforeAll(async () => {
    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.describeServer`);
    if (!res.ok) {
      throw new Error(
        `devnet PDS unreachable at ${PDS_URL}: ${res.status} ${await res.text()}`,
      );
    }
    pdsDid = ((await res.json()) as { did: string }).did;

    const iso = await createIsolatedSchema("test_reap_tombstone_e2e");
    pool = iso.pool;
    cleanupSchema = iso.cleanup;
    const db = createPostgresDatabase(pool);
    await initCommunitySchema(db);
    adapter = new CommunityAdapter(db);
    cipher = new CredentialCipher(new Uint8Array(32).fill(7));
  }, 15_000);

  afterAll(async () => {
    await cleanupSchema?.();
  });

  const pdsClient: PdsClient = {
    createAccount: ({ pdsUrl, serviceAuthJwt, body }) =>
      pdsCreateAccount(pdsUrl, serviceAuthJwt, body),
    getRecommendedDidCredentials: ({ pdsUrl, accessJwt }) =>
      pdsGetRecommendedDidCredentials(pdsUrl, accessJwt),
    activateAccount: ({ pdsUrl, accessJwt }) => pdsActivateAccount(pdsUrl, accessJwt),
    createAppPassword: ({ pdsUrl, accessJwt, name }) =>
      pdsCreateAppPassword(pdsUrl, accessJwt, name),
  };

  const plcClient: PlcClient = {
    submit: (did, op) => submitGenesisOp(PLC_URL, did, op as any),
    getLastOpCid: (did) => getLastOpCid(PLC_URL, did),
  };

  async function mintInvite(): Promise<string> {
    const inviteRes = await fetch(
      `${PDS_URL}/xrpc/com.atproto.server.createInviteCode`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(
            `admin:${PDS_ADMIN_PASSWORD}`,
          ).toString("base64")}`,
        },
        body: JSON.stringify({ useCount: 1 }),
      },
    );
    if (!inviteRes.ok) {
      throw new Error(
        `createInviteCode failed (${inviteRes.status}): ${await inviteRes.text()}`,
      );
    }
    return ((await inviteRes.json()) as { code: string }).code;
  }

  it(
    "tombstone op submitted to PLC has the CID we computed locally via cidForOp",
    async () => {
      // Provision a fresh community to land a real DID on devnet PLC.
      const inviteCode = await mintInvite();
      const suffix = `${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const handle = `tomb-${suffix}${HANDLE_DOMAIN}`;
      const email = `${suffix}@devnet.test`;
      const password = `pw-${suffix}`;
      const attemptId = randomUUID();

      const callerRotation = await generateKeyPair();

      const orch = new ProvisionOrchestrator({
        adapter,
        cipher,
        plc: plcClient,
        pds: pdsClient,
        pdsDid,
      });
      const result = await orch.provision({
        attemptId,
        pdsEndpoint: PDS_URL,
        handle,
        email,
        password,
        inviteCode,
        rotationKey: callerRotation.publicDidKey,
      });
      expect(result.status).toBe("activated");
      const did = result.did;

      // Pull the encrypted rotation key off the persisted row — same path
      // runReap takes.
      const row = await adapter.getProvisionAttempt(attemptId);
      expect(row).not.toBeNull();
      expect(row!.encryptedRotationKey).toBeTruthy();
      const rotationJwk = JSON.parse(
        await cipher.decryptString(row!.encryptedRotationKey!),
      ) as { kty: string; crv: string; x: string; y: string; d: string };

      // Drive the tombstone path the same way reap.ts does, but inline so
      // the test pins the cidForOp CID independent of runReap's archival
      // bookkeeping.
      const prev = await getLastOpCid(PLC_URL, did);
      const unsigned = buildTombstoneOp(prev);
      const signed = await signTombstoneOp(unsigned, rotationJwk);
      const expectedCid = await cidForOp(signed as never);

      await submitTombstoneOp(PLC_URL, did, signed);

      // PLC's log/last for the DID must now report the same CID we computed.
      // If cidForOp's tombstone encoding ever drifts from PLC's, this is the
      // failure mode that catches it.
      const lastCid = await getLastOpCid(PLC_URL, did);
      expect(lastCid).toBe(expectedCid);
    },
    45_000,
  );
});
