/**
 * End-to-end test exercising the full ProvisionOrchestrator flow against the
 * live devnet stack (PDS on :4000, PLC on :2582). Validates the 5-RPC sequence
 *   genesis op → createAccount → getRecommendedDidCredentials
 *               → PLC update op → activateAccount
 * lands an activated account.
 *
 * Catches integration bugs that mocks can't:
 *   - hand-rolled ES256 service-auth JWT vs real atproto verifier
 *   - hand-rolled DAG-CBOR encoder output vs real PLC parser
 *   - genesis-op DID computation matches what PLC expects
 *   - cidForOp output accepted by PLC as `prev` for the update op
 *   - low-S signature normalization
 *
 * Prereqs: `pnpm stack:up` (devnet PDS+PLC + postgres reachable).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Client } from "@atcute/client";
import {
  CommunityAdapter,
  CredentialCipher,
  Contrail,
  ProvisionOrchestrator,
  initCommunitySchema,
  pdsCreateAccount,
  pdsGetRecommendedDidCredentials,
  pdsActivateAccount,
  pdsCreateAppPassword,
  generateKeyPair,
  createPdsSession,
  submitGenesisOp,
  getLastOpCid,
  type PdsClient,
  type PlcClient,
} from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import {
  PDS_URL,
  PLC_URL,
  HANDLE_DOMAIN,
  PDS_ADMIN_PASSWORD,
  CONTRAIL_SERVICE_DID,
  createCaller,
  createDevnetResolver,
  createIsolatedSchema,
  createTestAccount,
  login,
  type CallAs,
  type TestAccount,
} from "./helpers";

describe("ProvisionOrchestrator devnet e2e", () => {
  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let adapter: CommunityAdapter;
  let cipher: CredentialCipher;
  let pdsDid: string;

  beforeAll(async () => {
    // Discover the live PDS's DID via describeServer — used as the `aud`
    // claim in the service-auth JWT we mint for createAccount.
    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.describeServer`);
    if (!res.ok) {
      throw new Error(
        `devnet PDS unreachable at ${PDS_URL}: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { did?: string };
    if (!body.did) {
      throw new Error(`describeServer response missing did: ${JSON.stringify(body)}`);
    }
    pdsDid = body.did;

    const iso = await createIsolatedSchema("test_provision_e2e");
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

  // Adapt our bare module-level functions to the orchestrator's wrapper
  // interfaces. Shared by the managed and self-sovereign tests so they hit
  // the same live PDS surface (Task 16 added createAppPassword to PdsClient).
  const pdsClient: PdsClient = {
    createAccount: ({ pdsUrl, serviceAuthJwt, body }) =>
      pdsCreateAccount(pdsUrl, serviceAuthJwt, body),
    getRecommendedDidCredentials: ({ pdsUrl, accessJwt }) =>
      pdsGetRecommendedDidCredentials(pdsUrl, accessJwt),
    activateAccount: ({ pdsUrl, accessJwt }) =>
      pdsActivateAccount(pdsUrl, accessJwt),
    createAppPassword: ({ pdsUrl, accessJwt, name }) =>
      pdsCreateAppPassword(pdsUrl, accessJwt, name),
  };

  const plcClient: PlcClient = {
    submit: (did, op) => submitGenesisOp(PLC_URL, did, op as any),
    getLastOpCid: (did) => getLastOpCid(PLC_URL, did),
  };

  /** Mint a single-use invite via the PDS admin API. Shared helper for both
   *  the managed and self-sovereign tests. */
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
    "provisions a self-sovereign community: caller holds rotation key, contrail mints app password",
    async () => {
      // Caller-held rotation keypair. The private JWK never leaves this test —
      // only callerRotation.publicDidKey is passed to the orchestrator. That's
      // the negative invariant we assert below: no encrypted_* column on the
      // persisted row contains the caller's did:key after decrypt.
      const callerRotation = await generateKeyPair();

      const inviteCode = await mintInvite();

      // Keep handle short — devnet caps the local label at 18 chars.
      // `ss-` (3) + 8-char suffix = 11 chars on the local label.
      const suffix = `${Date.now().toString(36).slice(-5)}${Math.random()
        .toString(36)
        .slice(2, 5)}`;
      const handle = `ss-${suffix}${HANDLE_DOMAIN}`;
      const email = `${suffix}@devnet.test`;
      const password = `pw-${suffix}`;
      const attemptId = randomUUID();

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

      // Result-shape assertions: status activated; rootCredentials returned
      // with the user's *root* password, not the minted app password.
      expect(result.attemptId).toBe(attemptId);
      expect(result.did).toMatch(/^did:plc:[a-z2-7]{24}$/);
      expect(result.status).toBe("activated");
      expect(result.rootCredentials).toBeDefined();
      expect(result.rootCredentials!.handle).toBe(handle);
      expect(result.rootCredentials!.password).toBe(password);
      expect(typeof result.rootCredentials!.recoveryHint).toBe("string");
      expect(result.rootCredentials!.recoveryHint.length).toBeGreaterThan(0);

      // Persisted-row assertions: self-sovereign mode persists an *encrypted
      // app password* — never the user's root password. Contrail's rotation
      // key is the SUBORDINATE (rotationKeys[1]); the caller's did:key is
      // rotationKeys[0] in the genesis op and lives only in PLC, never in
      // any encrypted_* column.
      const row = await adapter.getProvisionAttempt(attemptId);
      expect(row).not.toBeNull();
      expect(row!.status).toBe("activated");
      expect(row!.did).toBe(result.did);
      expect(row!.handle).toBe(handle);
      expect(row!.encryptedSigningKey).toBeTruthy();
      expect(row!.encryptedRotationKey).toBeTruthy();
      expect(row!.encryptedPassword).toBeTruthy();
      expect(row!.activatedAt).toBeTruthy();
      expect(row!.lastError).toBeNull();

      // Decrypt the persisted password — it must be the *minted app password*,
      // distinct from the user's root password we supplied.
      const decryptedAppPassword = await cipher.decryptString(
        row!.encryptedPassword!,
      );
      expect(decryptedAppPassword).not.toBe(password);
      expect(decryptedAppPassword.length).toBeGreaterThan(0);

      // Decrypt the persisted rotation JWK — it must be Contrail's subordinate
      // key (a fresh P-256 keypair), NOT the caller's. We assert NOT-equal on
      // the JWK shape, including the `d` (private) coordinate which the caller
      // never sent.
      const decryptedRotationJwk = JSON.parse(
        await cipher.decryptString(row!.encryptedRotationKey!),
      ) as { kty?: string; crv?: string; x?: string; y?: string; d?: string };
      expect(decryptedRotationJwk.kty).toBe("EC");
      expect(decryptedRotationJwk.crv).toBe("P-256");
      // The caller's private `d` coordinate must never appear in Contrail's
      // persistence — the strongest single-bit invariant of self-sovereign mode.
      expect(decryptedRotationJwk.d).not.toBe(callerRotation.privateJwk.d);
      // The public x/y must also differ — the persisted rotation key is a
      // subordinate Contrail-generated key, not a re-derivation of the caller's.
      expect(decryptedRotationJwk.x).not.toBe(callerRotation.privateJwk.x);
      expect(decryptedRotationJwk.y).not.toBe(callerRotation.privateJwk.y);

      // Negative invariant: the caller's public did:key string must NOT appear
      // inside ANY encrypted column after decryption. Encrypted_signing_key
      // is a JWK; encrypted_rotation_key is the subordinate JWK; the password
      // is opaque — none of them should contain the caller's did:key.
      const decryptedSigningKey = await cipher.decryptString(
        row!.encryptedSigningKey!,
      );
      const callerDidKey = callerRotation.publicDidKey;
      expect(decryptedSigningKey.indexOf(callerDidKey)).toBe(-1);
      expect(
        await cipher
          .decryptString(row!.encryptedRotationKey!)
          .then((s) => s.indexOf(callerDidKey)),
      ).toBe(-1);
      expect(decryptedAppPassword.indexOf(callerDidKey)).toBe(-1);

      // Prove the *minted* app password works against the live PDS.
      // createPdsSession throws if the PDS rejects.
      const appSession = await createPdsSession(
        PDS_URL,
        handle,
        decryptedAppPassword,
      );
      expect(appSession.did).toBe(result.did);
      expect(appSession.accessJwt).toBeTruthy();

      // And the user's root password also still works — PDS supports multiple
      // credentials per account, so the caller's root creds remain valid.
      const rootSession = await createPdsSession(PDS_URL, handle, password);
      expect(rootSession.did).toBe(result.did);
      expect(rootSession.accessJwt).toBeTruthy();

      // PLC-log assertion (H2): the post-activation update op must keep the
      // caller's did:key at rotationKeys[0]. Without this, contrail's
      // subordinate would silently take rotation priority and the caller
      // would lose self-sovereign recovery authority.
      const logRes = await fetch(`${PLC_URL}/${result.did}/log`);
      expect(logRes.ok).toBe(true);
      const log = (await logRes.json()) as Array<{
        rotationKeys: string[];
      }>;
      expect(log.length).toBeGreaterThanOrEqual(2);
      const lastOp = log[log.length - 1]!;
      expect(lastOp.rotationKeys[0]).toBe(callerRotation.publicDidKey);
    },
    30_000,
  );
});

/**
 * Routed end-to-end coverage for the XRPC surface of the provision flow:
 * `${NS}.community.provision` then `${NS}.community.putRecord` against the
 * same provisioned community. Differs from the orchestrator-only test above
 * by exercising the full Hono app — auth middleware, DB persistence,
 * bootstrapReservedSpaces, and the credential-proxy publish path that
 * Tasks 13/14 added.
 *
 * Also pins the Task 14 session-cache behavior: two sequential putRecords
 * should perform exactly **one** `com.atproto.server.createSession` call to
 * the PDS — the second hits the cached session.
 */
describe("community.provision + putRecord via XRPC route (devnet)", () => {
  const NS = "rsvp.atmo.community";
  const SPACE_TYPE = "rsvp.atmo.event.space";
  const POST_NSID = "app.bsky.feed.post";
  const TEST_MASTER_KEY = new Uint8Array(32).fill(7);

  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let pdsDid: string;
  let alice: TestAccount;
  let aliceClient: Client;
  let handle: (req: Request) => Promise<Response>;
  let callAs: CallAs;

  // Counts createSession calls to the live PDS so we can assert that the
  // session cache is reused across publishes (Task 14).
  let createSessionCount = 0;

  beforeAll(async () => {
    // Discover the live PDS's DID — needed as `aud` in the orchestrator's
    // service-auth JWT for createAccount.
    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.describeServer`);
    if (!res.ok) {
      throw new Error(
        `devnet PDS unreachable at ${PDS_URL}: ${res.status} ${await res.text()}`,
      );
    }
    pdsDid = ((await res.json()) as { did?: string }).did!;

    const iso = await createIsolatedSchema("test_provision_router_e2e");
    pool = iso.pool;
    cleanupSchema = iso.cleanup;
    const db = createPostgresDatabase(pool);

    // Wrap fetch to count createSession calls. Everything else passes
    // through unchanged so the orchestrator + publish paths hit real devnet.
    const countingFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/xrpc/com.atproto.server.createSession")) {
        createSessionCount++;
      }
      return fetch(input as any, init);
    };

    const contrail = new Contrail({
      ...{
        namespace: "rsvp.atmo",
        collections: {
          // Minimal collection set — we only need community routes registered;
          // no Jetstream ingestion is required for this test.
          post: { collection: POST_NSID },
        },
      },
      db,
      spaces: {
        type: SPACE_TYPE,
        serviceDid: CONTRAIL_SERVICE_DID,
        resolver: createDevnetResolver(),
      },
      community: {
        // The orchestrator uses cfg.serviceDid as the `aud` of the
        // createAccount service-auth JWT. The live devnet PDS validates
        // `aud` against its own DID, so this must be the PDS's DID — not
        // the Contrail service DID used for inbound JWT verification.
        serviceDid: pdsDid,
        masterKey: TEST_MASTER_KEY,
        plcDirectory: PLC_URL,
        resolver: createDevnetResolver(),
        fetch: countingFetch,
      },
    });
    await contrail.init();
    handle = createHandler(contrail);
    callAs = createCaller(handle);

    // Alice acts as the provisioning caller — she becomes owner of the new
    // community's $admin and $publishers spaces, which lets her publish.
    alice = await createTestAccount();
    aliceClient = await login(alice);
  }, 30_000);

  afterAll(async () => {
    await cleanupSchema?.();
  });

  it(
    "provisions via the XRPC route and publishes a record (one cached session across two putRecords)",
    async () => {
      // Mint an invite code via the PDS admin API — same pattern as the
      // orchestrator-only test above.
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
      const { code: inviteCode } = (await inviteRes.json()) as { code: string };

      // Keep total label under PDS's 18-char limit: `r-` (2) + 8-char suffix
      // = 10 chars, well under the cap.
      const suffix = `${Date.now().toString(36).slice(-6)}${Math.random()
        .toString(36)
        .slice(2, 4)}`;
      const newHandle = `r-${suffix}${HANDLE_DOMAIN}`;
      const email = `${suffix}@devnet.test`;
      const password = `pw-${suffix}`;

      const callerRotation = await generateKeyPair();

      const baselineCreateSessionCount = createSessionCount;

      // ---- POST /xrpc/${NS}.provision -----------------------------------
      const provRes = await callAs(aliceClient, "POST", `${NS}.provision`, {
        body: {
          handle: newHandle,
          email,
          password,
          inviteCode,
          pdsEndpoint: PDS_URL,
          rotationKey: callerRotation.publicDidKey,
        },
      });
      const provText = await provRes.clone().text();
      expect(provRes.status, provText).toBe(200);
      const provBody = (await provRes.json()) as {
        communityDid: string;
        status: string;
      };
      expect(provBody.status).toBe("activated");
      expect(provBody.communityDid).toMatch(/^did:plc:[a-z2-7]{24}$/);
      const communityDid = provBody.communityDid;

      // The orchestrator never calls createSession during provision — it
      // gets accessJwt + refreshJwt directly from the createAccount response
      // and seeds the community_sessions cache before returning, so the first
      // publish hits a warm cache.
      const provisionCreateSessionCount =
        createSessionCount - baselineCreateSessionCount;
      expect(provisionCreateSessionCount).toBe(0);

      // ---- First putRecord: cache miss → createSession ------------------
      const firstRecord = {
        $type: POST_NSID,
        text: `routed-e2e first ${suffix}`,
        createdAt: new Date().toISOString(),
      };
      const put1 = await callAs(aliceClient, "POST", `${NS}.putRecord`, {
        body: {
          communityDid,
          collection: POST_NSID,
          record: firstRecord,
        },
      });
      const put1Text = await put1.clone().text();
      expect(put1.status, put1Text).toBe(200);
      const put1Body = (await put1.json()) as { uri: string; cid: string };
      expect(put1Body.uri).toMatch(
        new RegExp(`^at://${communityDid}/${POST_NSID}/`),
      );
      expect(put1Body.cid).toBeTruthy();

      // ---- Second putRecord: cache hit → no createSession ---------------
      const secondRecord = {
        $type: POST_NSID,
        text: `routed-e2e second ${suffix}`,
        createdAt: new Date().toISOString(),
      };
      const put2 = await callAs(aliceClient, "POST", `${NS}.putRecord`, {
        body: {
          communityDid,
          collection: POST_NSID,
          record: secondRecord,
        },
      });
      const put2Text = await put2.clone().text();
      expect(put2.status, put2Text).toBe(200);
      const put2Body = (await put2.json()) as { uri: string; cid: string };
      expect(put2Body.uri).toMatch(
        new RegExp(`^at://${communityDid}/${POST_NSID}/`),
      );

      // Zero createSession across the whole flow: provision pre-warms the
      // cache, then both publishes hit the 30s-skew cache.
      const publishesCreateSessionCount =
        createSessionCount - baselineCreateSessionCount;
      expect(publishesCreateSessionCount).toBe(0);
    },
    60_000,
  );

  // TODO: cover stale-session auto-recovery (provision Task 14, ensureSession
  // refresh path). Hard to exercise deterministically against live devnet
  // without aging out a real `accessExp` past the 30s skew; covered by unit
  // tests in packages/contrail/tests/community-publishing.test.ts.
});
