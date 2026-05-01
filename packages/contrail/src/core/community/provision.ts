/** Provision orchestrator: runs the 5-RPC flow (genesis → createAccount →
 *  recommendedCreds → PLC update → activate), persisting status after each
 *  step so the recovery sweeper can resume from any point.
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
}

export interface ProvisionResult {
  attemptId: string;
  did: string;
  status: "activated";
}

export class ProvisionOrchestrator {
  constructor(private deps: ProvisionOrchestratorDeps) {}

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const { adapter, cipher, plc, pds, pdsDid } = this.deps;

    // Step 0: keys + persist
    const signingKey = await generateKeyPair();
    const rotationKey = await generateKeyPair();
    const encryptedSigning = await cipher.encrypt(
      JSON.stringify(signingKey.privateJwk)
    );
    const encryptedRotation = await cipher.encrypt(
      JSON.stringify(rotationKey.privateJwk)
    );

    const unsigned = buildGenesisOp({
      rotationKeys: [rotationKey.publicDidKey],
      verificationMethodAtproto: signingKey.publicDidKey,
      alsoKnownAs: [`at://${input.handle}`],
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: input.pdsEndpoint,
        },
      },
    });
    const signedGenesis = await signGenesisOp(unsigned, rotationKey.privateJwk);
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
      const encryptedPassword = await cipher.encrypt(input.password);
      await adapter.updateProvisionStatus(input.attemptId, "account_created", {
        encryptedPassword,
      });
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
      rotationPrivateJwk: rotationKey.privateJwk,
      rotationPublicDidKey: rotationKey.publicDidKey,
      prevCid: await cidForOp(signedGenesis),
    });

    return { attemptId: input.attemptId, did, status: "activated" };
  }

  /** Resume a stuck attempt that already advanced past createAccount.
   *  Picks up at step 3, fetches the genesis CID from the PLC directory, and
   *  drives steps 4-5 to completion. The caller (sweeper) provides the
   *  accessJwt obtained from a fresh createSession against the deactivated
   *  account. */
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
    prevCid: string;
  }): Promise<void> {
    const { adapter, plc, pds } = this.deps;

    // Step 3 + 4: getRecommendedDidCredentials + PLC update op
    try {
      const recommended = await pds.getRecommendedDidCredentials({
        pdsUrl: args.pdsEndpoint,
        accessJwt: args.accessJwt,
      });
      const updatedRotationKeys = [
        args.rotationPublicDidKey,
        ...recommended.rotationKeys.filter(
          (k) => k !== args.rotationPublicDidKey
        ),
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
