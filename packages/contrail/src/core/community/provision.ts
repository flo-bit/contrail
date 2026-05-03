/** Provision orchestrator: runs the 5-RPC flow (genesis → createAccount →
 *  recommendedCreds → PLC update → activate), persisting status after each
 *  step so a stuck attempt can be resumed via `resumeFromAccountCreated`.
 *
 *  Steps and persisted statuses:
 *    Step 0  generate keys + persist row                       → keys_generated
 *    Step 1  PLC genesis op                                    → genesis_submitted
 *    Step 2  PDS createAccount (service-auth JWT)              → account_created
 *    Step 3  fetch recommended DID credentials                 (no status change)
 *    Step 4  PLC update op merging recommended credentials     → did_doc_updated
 *    Step 5  PDS activateAccount                               → activated
 */

import {
  generateKeyPair,
  buildGenesisOp,
  signGenesisOp,
  computeDidPlc,
  buildUpdateOp,
  signUpdateOp,
  cidForOp,
  jwkToDidKey,
} from "./plc";
import type { RecommendedDidCredentials } from "./pds";
import { decodeJwtExp } from "./pds";
import { mintServiceAuthJwt } from "./service-auth";
import type { CommunityAdapter } from "./adapter";
import type { CredentialCipher } from "./credentials";

export interface PlcClient {
  submit(did: string, op: any): Promise<unknown>;
  /** Returns the CID of the most recent op in the DID's PLC log. Used by the
   *  resume path to set `prev` on a fresh update op. */
  getLastOpCid(did: string): Promise<string>;
}

export interface PdsClient {
  createAccount(input: {
    pdsUrl: string;
    serviceAuthJwt: string;
    body: {
      handle: string;
      did: string;
      email: string;
      password: string;
      inviteCode?: string;
    };
  }): Promise<{
    did: string;
    handle: string;
    accessJwt: string;
    refreshJwt: string;
  }>;
  getRecommendedDidCredentials(input: {
    pdsUrl: string;
    accessJwt: string;
  }): Promise<RecommendedDidCredentials>;
  activateAccount(input: { pdsUrl: string; accessJwt: string }): Promise<void>;
  /** Mints a revocable app password on the freshly-activated account. Used by
   *  the self-sovereign custody mode so Contrail keeps publishing authority
   *  without holding the account's root password. */
  createAppPassword(input: {
    pdsUrl: string;
    accessJwt: string;
    name: string;
  }): Promise<{ password: string }>;
  /** Used only by the C3 retry path: when a provision call failed at
   *  createAppPassword, retrying with the same attemptId needs a fresh
   *  accessJwt. The session-cache JWT from the failed attempt may have
   *  expired by the time the caller retries. Optional — non-retry callers
   *  never invoke this. */
  createSession?(input: {
    pdsUrl: string;
    identifier: string;
    password: string;
  }): Promise<{ accessJwt: string; refreshJwt: string; did: string }>;
}

export interface ProvisionOrchestratorDeps {
  adapter: CommunityAdapter;
  cipher: CredentialCipher;
  plc: PlcClient;
  pds: PdsClient;
  /** DID of the target PDS; used as `aud` in the service-auth JWT. */
  pdsDid: string;
}

export interface ProvisionInput {
  attemptId: string;
  pdsEndpoint: string;
  handle: string;
  email: string;
  password: string;
  inviteCode?: string;
  /** Caller-supplied rotation public key (did:key:z…). Sits at rotationKeys[0]
   *  in the genesis op; Contrail's generated key is the subordinate at [1].
   *  After activation Contrail mints a revocable app password (via
   *  createAppPassword) for ongoing publishing — the user's account password
   *  is never persisted. */
  rotationKey: string;
}

export interface ProvisionResult {
  attemptId: string;
  did: string;
  status: "activated";
  /** The caller is expected to store these — Contrail does NOT retain the
   *  user's root password once the app password has been minted. */
  rootCredentials: {
    handle: string;
    password: string;
    recoveryHint: string;
  };
}

export class ProvisionOrchestrator {
  constructor(private deps: ProvisionOrchestratorDeps) {}

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const { adapter, cipher, plc, pds, pdsDid } = this.deps;

    if (!isDidKeyZ(input.rotationKey)) {
      throw new Error(
        `rotationKey must be a did:key:z… string (got: ${input.rotationKey.slice(0, 24)}…)`
      );
    }

    // Idempotent retry: a caller that gets a 5xx with an attemptId can
    // re-invoke provision with the SAME attemptId and the orchestrator picks
    // up where it left off. The shape we recover from here is an attempt that
    // completed activation but whose post-activation createAppPassword failed
    // (no encryptedPassword stored). Other partial states
    // (e.g. status='account_created') are out of scope — they should use
    // resumeFromAccountCreated.
    const existing = await adapter.getProvisionAttempt(input.attemptId);
    if (existing) {
      if (existing.status === "activated" && !existing.encryptedPassword) {
        return this.retryAppPasswordOnly(input, existing);
      }
      throw new Error(
        `provision attempt ${input.attemptId} already exists at status="${existing.status}"; ` +
          `retry is only supported for attempts that failed at createAppPassword`
      );
    }

    // Step 0: keys + persist. Contrail generates a SUBORDINATE rotation key
    // (rotationKeys[1]) so it retains a path to submit subsequent PLC ops;
    // the caller's key sits at rotationKeys[0].
    const signingKey = await generateKeyPair();
    const contrailRotation = await generateKeyPair();
    const encryptedSigning = await cipher.encrypt(
      JSON.stringify(signingKey.privateJwk)
    );
    const encryptedRotation = await cipher.encrypt(
      JSON.stringify(contrailRotation.privateJwk)
    );

    const unsigned = buildGenesisOp({
      rotationKeys: [input.rotationKey, contrailRotation.publicDidKey],
      verificationMethodAtproto: signingKey.publicDidKey,
      alsoKnownAs: [`at://${input.handle}`],
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: input.pdsEndpoint,
        },
      },
    });
    // Genesis is signed with Contrail's subordinate rotation key — it's listed
    // at rotationKeys[1] so PLC accepts the signature.
    const signedGenesis = await signGenesisOp(unsigned, contrailRotation.privateJwk);
    const did = await computeDidPlc(signedGenesis);

    await adapter.createProvisionAttempt({
      attemptId: input.attemptId,
      did,
      pdsEndpoint: input.pdsEndpoint,
      handle: input.handle,
      email: input.email,
      inviteCode: input.inviteCode ?? null,
      encryptedSigningKey: encryptedSigning,
      encryptedRotationKey: encryptedRotation,
      callerRotationDidKey: input.rotationKey,
    });

    // Step 1: PLC genesis
    try {
      await plc.submit(did, signedGenesis);
      await adapter.updateProvisionStatus(input.attemptId, "genesis_submitted");
    } catch (err: any) {
      await adapter.updateProvisionStatus(input.attemptId, "keys_generated", {
        lastError: `plc-genesis: ${err.message}`,
      });
      throw err;
    }

    // Step 2: createAccount
    let session: {
      did: string;
      handle: string;
      accessJwt: string;
      refreshJwt: string;
    };
    try {
      const serviceAuthJwt = await mintServiceAuthJwt({
        privateJwk: signingKey.privateJwk,
        iss: did,
        aud: pdsDid,
        lxm: "com.atproto.server.createAccount",
        ttlSec: 60,
      });
      session = await pds.createAccount({
        pdsUrl: input.pdsEndpoint,
        serviceAuthJwt,
        body: {
          handle: input.handle,
          did,
          email: input.email,
          password: input.password,
          inviteCode: input.inviteCode,
        },
      });
      await adapter.updateProvisionStatus(input.attemptId, "account_created");
    } catch (err: any) {
      await adapter.updateProvisionStatus(input.attemptId, "genesis_submitted", {
        lastError: `createAccount: ${err.message}`,
      });
      throw err;
    }

    await this.runUpdateAndActivate({
      attemptId: input.attemptId,
      did,
      pdsEndpoint: input.pdsEndpoint,
      accessJwt: session.accessJwt,
      rotationPrivateJwk: contrailRotation.privateJwk,
      rotationPublicDidKey: contrailRotation.publicDidKey,
      callerRotationPublicDidKey: input.rotationKey,
      prevCid: await cidForOp(signedGenesis),
    });

    // Seed the session cache with the JWTs createAccount returned, so the
    // first publish doesn't waste a createSession round-trip. ensureSession
    // refreshes or falls back to the stored password as the JWTs age out.
    await adapter.upsertSession(did, {
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
      accessExp: decodeJwtExp(session.accessJwt),
    });

    // Mint a revocable app password so we can publish without holding the
    // user's root password. Failure here leaves the row at status=activated
    // (the account IS activated upstream) with a last_error breadcrumb; the
    // caller can retry with the same attemptId and it will pick up at
    // createAppPassword only (see retryAppPasswordOnly).
    try {
      const minted = await pds.createAppPassword({
        pdsUrl: input.pdsEndpoint,
        accessJwt: session.accessJwt,
        name: `contrail-${input.attemptId}`,
      });
      const encryptedPassword = await cipher.encrypt(minted.password);
      await adapter.updateProvisionStatus(input.attemptId, "activated", {
        encryptedPassword,
      });
    } catch (err: any) {
      await adapter.updateProvisionStatus(input.attemptId, "activated", {
        lastError: `createAppPassword: ${err.message}`,
      });
      // Wrap the error so the route handler / log readers see immediately
      // that this is the recoverable retry case, not a generic PDS failure.
      throw new Error(`createAppPassword: ${err.message}`);
    }

    return {
      attemptId: input.attemptId,
      did,
      status: "activated",
      rootCredentials: {
        handle: input.handle,
        password: input.password,
        recoveryHint: "store this — Contrail does not retain it",
      },
    };
  }

  /** C3 retry path. Triggered when provision() is called with an attemptId
   *  whose row is at status='activated' + no encrypted_password. The DID is
   *  already on PLC; the PDS account is already created and activated; only
   *  the post-activation app-password mint failed. We need a fresh accessJwt
   *  (the cached one may have expired by the time the caller retries), then
   *  re-run createAppPassword. */
  private async retryAppPasswordOnly(
    input: ProvisionInput,
    existing: NonNullable<Awaited<ReturnType<CommunityAdapter["getProvisionAttempt"]>>>
  ): Promise<ProvisionResult> {
    const { adapter, cipher, pds } = this.deps;
    if (!pds.createSession) {
      throw new Error(
        "retry path requires PdsClient.createSession to be wired (production buildOrchestrator does this; tests must stub it)"
      );
    }

    const session = await pds.createSession({
      pdsUrl: existing.pdsEndpoint,
      identifier: input.handle,
      password: input.password,
    });

    let mintedPassword: string;
    try {
      const minted = await pds.createAppPassword({
        pdsUrl: existing.pdsEndpoint,
        accessJwt: session.accessJwt,
        name: `contrail-${input.attemptId}`,
      });
      mintedPassword = minted.password;
    } catch (err: any) {
      await adapter.updateProvisionStatus(input.attemptId, "activated", {
        lastError: `createAppPassword (retry): ${err.message}`,
      });
      throw new Error(`createAppPassword (retry): ${err.message}`);
    }

    const encryptedPassword = await cipher.encrypt(mintedPassword);
    await adapter.updateProvisionStatus(input.attemptId, "activated", {
      encryptedPassword,
    });
    // Refresh the session cache with the JWTs we just obtained, so the
    // first publish for this community doesn't need another createSession.
    await adapter.upsertSession(existing.did, {
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
      accessExp: decodeJwtExp(session.accessJwt),
    });

    return {
      attemptId: input.attemptId,
      did: existing.did,
      status: "activated",
      rootCredentials: {
        handle: input.handle,
        password: input.password,
        recoveryHint: "store this — Contrail does not retain it",
      },
    };
  }

  /** Resume a stuck attempt that already advanced past createAccount.
   *  Picks up at step 3, fetches the genesis CID from the PLC directory, and
   *  drives steps 4-5 to completion. Caller obtains the accessJwt via a fresh
   *  createSession against the deactivated account (typically an operator-run
   *  recovery script). */
  async resumeFromAccountCreated(
    attemptId: string,
    accessJwt: string
  ): Promise<void> {
    const { adapter, cipher, plc } = this.deps;
    const row = await adapter.getProvisionAttempt(attemptId);
    if (!row) {
      throw new Error(`provision attempt not found: ${attemptId}`);
    }
    if (!row.encryptedRotationKey) {
      throw new Error(
        `provision attempt ${attemptId} has no encrypted rotation key`
      );
    }

    const rotationPrivateJwk = JSON.parse(
      await cipher.decryptString(row.encryptedRotationKey)
    ) as JsonWebKey;
    // We re-derive the rotation public did:key from the JWK to merge with the
    // PDS's recommended rotation keys (the local key must remain in the chain).
    const rotationPublicDidKey = jwkPubToDidKey(rotationPrivateJwk);

    const prevCid = await plc.getLastOpCid(row.did);

    await this.runUpdateAndActivate({
      attemptId,
      did: row.did,
      pdsEndpoint: row.pdsEndpoint,
      accessJwt,
      rotationPrivateJwk,
      rotationPublicDidKey,
      callerRotationPublicDidKey: row.callerRotationDidKey,
      prevCid,
    });
  }

  /** Steps 3-5: fetch recommended creds, sign + submit the PLC update op,
   *  activate the account. Shared by `provision()` and
   *  `resumeFromAccountCreated()`. The two outer try blocks here mirror the
   *  original linear flow so the persisted statuses on failure stay
   *  identical. */
  private async runUpdateAndActivate(args: {
    attemptId: string;
    did: string;
    pdsEndpoint: string;
    accessJwt: string;
    rotationPrivateJwk: JsonWebKey;
    rotationPublicDidKey: string;
    /** Caller-supplied rotation public did:key. Kept at index 0 of the update
     *  op's rotationKeys so the caller retains highest-priority rotation
     *  authority on the DID. */
    callerRotationPublicDidKey: string;
    prevCid: string;
  }): Promise<void> {
    const { adapter, plc, pds } = this.deps;

    // Step 3 + 4: getRecommendedDidCredentials + PLC update op
    try {
      const recommended = await pds.getRecommendedDidCredentials({
        pdsUrl: args.pdsEndpoint,
        accessJwt: args.accessJwt,
      });
      const baseRotationKeys = [args.callerRotationPublicDidKey, args.rotationPublicDidKey];
      const updatedRotationKeys = [
        ...baseRotationKeys,
        ...recommended.rotationKeys.filter((k) => !baseRotationKeys.includes(k)),
      ];
      const unsignedUpdate = buildUpdateOp({
        prev: args.prevCid,
        rotationKeys: updatedRotationKeys,
        verificationMethodAtproto: recommended.verificationMethods.atproto,
        alsoKnownAs: recommended.alsoKnownAs,
        services: recommended.services,
      });
      const signedUpdate = await signUpdateOp(
        unsignedUpdate,
        args.rotationPrivateJwk
      );
      await plc.submit(args.did, signedUpdate);
      await adapter.updateProvisionStatus(args.attemptId, "did_doc_updated");
    } catch (err: any) {
      await adapter.updateProvisionStatus(args.attemptId, "account_created", {
        lastError: `did-doc-update: ${err.message}`,
      });
      throw err;
    }

    // Step 5: activateAccount
    try {
      await pds.activateAccount({
        pdsUrl: args.pdsEndpoint,
        accessJwt: args.accessJwt,
      });
      await adapter.updateProvisionStatus(args.attemptId, "activated");
    } catch (err: any) {
      await adapter.updateProvisionStatus(args.attemptId, "did_doc_updated", {
        lastError: `activateAccount: ${err.message}`,
      });
      throw err;
    }
  }
}

/** Cheap structural check for did:key:z multibase identifiers. The orchestrator
 *  trusts the caller's submitted rotation key beyond this; PLC will reject any
 *  malformed key when the genesis op is submitted. */
function isDidKeyZ(s: string): boolean {
  return typeof s === "string" && s.startsWith("did:key:z") && s.length > 12;
}

/** Re-derive the did:key form of a P-256 public key from the private JWK.
 *  A P-256 private JWK includes the public x/y coordinates, so we can hand
 *  those to `jwkToDidKey` to recover the public did:key without round-tripping
 *  through Web Crypto. */
function jwkPubToDidKey(privateJwk: JsonWebKey): string {
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256") {
    throw new Error("expected EC P-256 JWK for rotation key");
  }
  if (!privateJwk.x || !privateJwk.y) {
    throw new Error("rotation private JWK is missing x/y coordinates");
  }
  return jwkToDidKey({
    kty: "EC",
    crv: "P-256",
    x: privateJwk.x,
    y: privateJwk.y,
  });
}
