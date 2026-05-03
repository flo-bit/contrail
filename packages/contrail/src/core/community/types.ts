import type { Database } from "../types";
import type { DidDocumentResolver } from "@atcute/identity-resolver";

/** Access level a subject (did or group-space) has on a given space.
 *  Levels are totally ordered. Higher levels include lower levels' powers.
 *  See docs/community.md for the exact semantics. */
export type AccessLevel = "member" | "manager" | "admin" | "owner";

export const ACCESS_LEVELS: readonly AccessLevel[] = [
  "member",
  "manager",
  "admin",
  "owner",
] as const;

export function rankOf(level: AccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

export function isAccessLevel(v: unknown): v is AccessLevel {
  return typeof v === "string" && ACCESS_LEVELS.includes(v as AccessLevel);
}

export type CommunityMode = "adopt" | "mint" | "provision";

export const PROVISION_STATUSES = [
  "keys_generated",
  "genesis_submitted",
  "account_created",
  "did_doc_updated",
  "activated",
  "orphaned",
] as const;
export type ProvisionStatus = (typeof PROVISION_STATUSES)[number];

export interface ProvisionAttemptRow {
  attemptId: string;
  did: string;
  status: ProvisionStatus;
  pdsEndpoint: string;
  handle: string;
  email: string;
  inviteCode: string | null;
  encryptedSigningKey: string | null;
  encryptedRotationKey: string | null;
  encryptedPassword: string | null;
  /** Caller-supplied rotation public did:key, persisted so PLC update ops
   *  (initial + resume) can keep it as rotationKeys[0]. */
  callerRotationDidKey: string;
  genesisSubmittedAt: number | null;
  accountCreatedAt: number | null;
  didDocUpdatedAt: number | null;
  activatedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProvisionAttemptInput {
  attemptId: string;
  did: string;
  pdsEndpoint: string;
  handle: string;
  email: string;
  inviteCode?: string | null;
  encryptedSigningKey: string;
  encryptedRotationKey: string;
  /** Caller-supplied rotation public did:key. The orchestrator persists this
   *  so PLC update ops (initial + resume) can keep it as rotationKeys[0]. */
  callerRotationDidKey: string;
}

export interface CommunityConfig {
  /** Service DID for JWT verification. Falls back to spaces.serviceDid when both modules are enabled. */
  serviceDid?: string;
  /** PLC directory host for minted communities. */
  plcDirectory?: string;
  /** Master key for envelope-encrypting stored credentials (app passwords, signing keys, rotation keys).
   *  Accepts a raw Uint8Array (preferred) or a base64/hex string that decodes to 32 bytes. */
  masterKey: Uint8Array | string;
  /** Optional override for DID resolution (used during adopt to resolve identifier → DID → PDS). */
  resolver?: DidDocumentResolver;
  /** Optional override for the fetch implementation (useful for tests). */
  fetch?: typeof fetch;
  /** Allowlist of PDS endpoints accepted by `community.provision`. When set
   *  to a non-empty array, callers must supply a `pdsEndpoint` that matches
   *  one of these entries exactly; other values are rejected before any PLC
   *  op is signed. Undefined or empty array → no restriction (back-compat).
   *  Operators running on a public/multi-tenant Contrail SHOULD set this so
   *  callers can't mint PLC entries pointing at attacker-controlled PDSes
   *  signed by Contrail's rotation key. */
  allowedPdsEndpoints?: string[];
}

/** Public view of a community row. Encrypted credentials are not included here
 *  — those live only behind CommunityAdapter.getRawCredentials(), which returns
 *  the base64 envelope string intended to be passed straight to CredentialCipher. */
export interface CommunityRow {
  did: string;
  mode: CommunityMode;
  pdsEndpoint: string | null;
  identifier: string | null;
  createdBy: string;
  createdAt: number;
  deletedAt: number | null;
}

export interface AccessLevelRow {
  spaceUri: string;
  subjectDid: string | null;
  subjectSpaceUri: string | null;
  accessLevel: AccessLevel;
  grantedBy: string;
  grantedAt: number;
}

/** A pre-signed grant for a community-owned space. An admin/manager creates
 *  one; anyone with the raw token can redeem it once to get the specified
 *  access level. Storage keeps only the SHA-256 of the token. */
export interface CommunityInviteRow {
  tokenHash: string;
  spaceUri: string;
  accessLevel: AccessLevel;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: number | null;
  note: string | null;
}

export interface CreateCommunityInviteInput {
  spaceUri: string;
  tokenHash: string;
  accessLevel: AccessLevel;
  createdBy: string;
  expiresAt: number | null;
  maxUses: number | null;
  note: string | null;
}

/** Key prefix for reserved community-owned spaces. */
export const RESERVED_KEYS = ["$admin", "$publishers"] as const;
export type ReservedKey = (typeof RESERVED_KEYS)[number];

export function isReservedKey(key: string): key is ReservedKey {
  return (RESERVED_KEYS as readonly string[]).includes(key);
}

export interface AdapterContext {
  db: Database;
}
