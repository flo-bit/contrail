import type { Database } from "../types";
import type { DidDocumentResolver } from "@atcute/identity-resolver";
import type { BlobAdapter } from "./blob-adapter";
import type { CredentialKeyMaterial } from "./credentials";

export type AppPolicyMode = "allow" | "deny";

export interface AppPolicy {
  mode: AppPolicyMode;
  apps: string[];
}

export interface SpacesBlobsConfig {
  /** Bytes backend (R2, S3, in-memory, …). */
  adapter: BlobAdapter;
  /** Max blob size in bytes. Defaults to 2 MiB. */
  maxSize?: number;
  /** MIME allowlist. If set, only these content types are accepted. */
  accept?: string[];
  /** Orphan blobs (those with no referencing record) are kept this long before
   *  GC can delete them, to allow upload-then-putRecord flows.
   *  Defaults to 24 hours. */
  gcOrphanAfterMs?: number;
}

export const DEFAULT_BLOB_MAX_SIZE = 2 * 1024 * 1024;
export const DEFAULT_BLOB_GC_ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

/** Default credential lifetime. The rough spec calls for 2–4h; we pick the
 *  lower bound so revocation (kicked-from-space) is observable within 2h. */
export const DEFAULT_CREDENTIAL_TTL_MS = 2 * 60 * 60 * 1000;

/** Configuration for the **space authority** role: holds the member list,
 *  signs credentials, and gates space-management operations. In a fully-split
 *  deployment, the authority can run in a different process (or even a
 *  different operator) than the record host. */
export interface AuthorityConfig {
  /** NSID that identifies the kind of space this authority hosts,
   *  e.g. "tools.atmo.event.space". */
  type: string;
  /** Service DID that service-auth tokens must target (aud claim) AND that
   *  signs credentials it issues (`iss` claim on emitted JWTs). */
  serviceDid: string;
  /** Default app policy applied to new spaces. */
  defaultAppPolicy?: AppPolicy;
  /** DID document resolver for service-auth JWT verification.
   *  Defaults to a composite PLC + did:web resolver if omitted. */
  resolver?: DidDocumentResolver;
  /** Signing key material for issuing space credentials. When omitted,
   *  `<ns>.space.getCredential` returns 501 NotImplemented and the record
   *  host's credential-verifying middleware can't be wired up. */
  signing?: CredentialKeyMaterial;
  /** Credential lifetime in ms. Defaults to {@link DEFAULT_CREDENTIAL_TTL_MS}. */
  credentialTtlMs?: number;
  /** Membership-manifest lifetime in ms. Manifests carry a user's full
   *  member-of list and let appviews filter unioned queries without syncing
   *  the authority's full member tables. Same key material as credentials.
   *  Defaults to {@link DEFAULT_MANIFEST_TTL_MS}. */
  manifestTtlMs?: number;
  /** Maximum number of spaces returned in a manifest. The endpoint paginates
   *  through `listSpaces` up to this cap; users with more spaces get a
   *  truncated manifest (the remainder won't be unioned in queries). Defaults
   *  to 500. */
  manifestMaxSpaces?: number;
}

/** Configuration for the **record host** role: stores per-space records and
 *  blobs and serves reads. Verifies space credentials (later phases) on
 *  incoming traffic. */
export interface RecordHostConfig {
  /** Blob-upload backend. When omitted, blob XRPCs are not exposed. */
  blobs?: SpacesBlobsConfig;
}

/** Spaces config — host an authority, a record host, or both.
 *  Today both run in one process and most deployments will set both; the
 *  shape is split now so phase 5 can run them independently without churning
 *  every consumer's config. */
export interface SpacesConfig {
  /** Space-authority config — member list, credentials (later), space
   *  management. Required for any space to exist. */
  authority?: AuthorityConfig;
  /** Record-host config — record + blob storage. Required for records to be
   *  written/read on this deployment. */
  recordHost?: RecordHostConfig;
}

export interface SpaceRow {
  uri: string;
  ownerDid: string;
  type: string;
  key: string;
  serviceDid: string;
  appPolicyRef: string | null;
  appPolicy: AppPolicy | null;
  createdAt: number;
  deletedAt: number | null;
}

export interface SpaceMemberRow {
  spaceUri: string;
  did: string;
  addedAt: number;
  addedBy: string | null;
}

export interface StoredRecord {
  spaceUri: string;
  collection: string;
  authorDid: string;
  rkey: string;
  cid: string | null;
  record: Record<string, unknown>;
  createdAt: number;
}

export interface ListOptions {
  byUser?: string;
  cursor?: string;
  limit?: number;
}

export interface ListResult {
  records: StoredRecord[];
  cursor?: string;
}

export interface ListSpacesOptions {
  type?: string;
  ownerDid?: string;
  memberDid?: string;
  limit?: number;
  cursor?: string;
}

export interface CollectionCount {
  collection: string;
  count: number;
}

/** What a token holder can do with this invite.
 *  - `'join'`: must be redeemed while signed in; redeemer becomes a member.
 *  - `'read'`: bearer-only — token itself grants read access to the space; cannot be redeemed.
 *  - `'read-join'`: both — anonymous holders read; signed-in holders may also redeem to join. */
export type InviteKind = "join" | "read" | "read-join";

export interface InviteRow {
  tokenHash: string;
  spaceUri: string;
  kind: InviteKind;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
  note: string | null;
}

export interface CreateInviteInput {
  spaceUri: string;
  tokenHash: string;
  kind: InviteKind;
  expiresAt: number | null;
  maxUses: number | null;
  createdBy: string;
  note: string | null;
}

export interface RedeemInviteResult {
  spaceUri: string;
}

export interface BlobMetaRow {
  spaceUri: string;
  cid: string;
  mimeType: string;
  size: number;
  authorDid: string;
  createdAt: number;
}

/** Local cache on the record host: this space is accepted here, and `authority_did`
 *  is the DID authorized to sign credentials for it. Populated via the
 *  `recordHost.enroll` endpoint or auto-populated by the authority's
 *  createSpace when both roles run in one process. */
export interface EnrollmentRow {
  spaceUri: string;
  authorityDid: string;
  enrolledAt: number;
  enrolledBy: string;
}

export interface ListBlobsOptions {
  byUser?: string;
  cursor?: string;
  limit?: number;
}

export interface ListBlobsResult {
  blobs: BlobMetaRow[];
  cursor?: string;
}

/** **Space authority** interface — owner of the space's ACL state and
 *  (eventually) credential issuer. Holds the member list, manages invites,
 *  governs space lifecycle and app policy. Does NOT touch records or blobs.
 *
 *  In a fully-split deployment this is a separate service; today the
 *  HostedAdapter implements both this and {@link RecordHost} against one DB. */
export interface SpaceAuthority {
  // Space lifecycle
  createSpace(space: Omit<SpaceRow, "createdAt" | "deletedAt">): Promise<SpaceRow>;
  getSpace(spaceUri: string): Promise<SpaceRow | null>;
  listSpaces(options: ListSpacesOptions): Promise<{ spaces: SpaceRow[]; cursor?: string }>;
  deleteSpace(spaceUri: string): Promise<void>;
  updateSpaceAppPolicy(spaceUri: string, appPolicy: AppPolicy): Promise<void>;

  // Members
  addMember(spaceUri: string, did: string, addedBy: string | null): Promise<void>;
  removeMember(spaceUri: string, did: string): Promise<void>;
  getMember(spaceUri: string, did: string): Promise<SpaceMemberRow | null>;
  listMembers(spaceUri: string): Promise<SpaceMemberRow[]>;
  /** Bulk-apply a membership diff. Used only by the community module's reconciler;
   *  not exposed as an XRPC endpoint. */
  applyMembershipDiff(
    spaceUri: string,
    adds: string[],
    removes: string[],
    addedBy: string | null
  ): Promise<void>;

  // Invites (token primitive — issued by the authority, scoped to a space)
  createInvite(input: CreateInviteInput): Promise<InviteRow>;
  listInvites(spaceUri: string, options?: { includeRevoked?: boolean }): Promise<InviteRow[]>;
  revokeInvite(tokenHash: string): Promise<boolean>;
  /** Look up an invite without consuming it. Used to validate read-token bearer access. */
  getInvite(tokenHash: string): Promise<InviteRow | null>;
  /** Atomically mark a join-capable invite as used. Returns the row if usable
   *  (kind allows join, not expired/revoked/exhausted), null otherwise. */
  redeemInvite(tokenHash: string, now: number): Promise<InviteRow | null>;
}

/** **Record host** interface — stores records and blobs for a space, plus
 *  the local enrollment table that decides which spaces this host accepts.
 *
 *  Trust model: the host trusts whatever credential the authority signs, so
 *  long as the authority is the one named in the local enrollment for this
 *  space. Enrollment is the consent step — the host owner agrees to spend
 *  storage on a given space, scoped to a specific authority. */
export interface RecordHost {
  // Enrollment
  enroll(input: EnrollmentRow): Promise<void>;
  getEnrollment(spaceUri: string): Promise<EnrollmentRow | null>;
  listEnrollments(options?: { authorityDid?: string; limit?: number }): Promise<EnrollmentRow[]>;
  removeEnrollment(spaceUri: string): Promise<void>;

  // Records
  putRecord(record: StoredRecord): Promise<void>;
  getRecord(spaceUri: string, collection: string, authorDid: string, rkey: string): Promise<StoredRecord | null>;
  listRecords(spaceUri: string, collection: string, options?: ListOptions): Promise<ListResult>;
  deleteRecord(spaceUri: string, collection: string, authorDid: string, rkey: string): Promise<void>;
  listCollections(spaceUri: string, options?: { byUser?: string }): Promise<CollectionCount[]>;

  // Blobs (metadata only; bytes live on BlobAdapter)
  putBlobMeta(row: BlobMetaRow): Promise<void>;
  getBlobMeta(spaceUri: string, cid: string): Promise<BlobMetaRow | null>;
  listBlobMeta(spaceUri: string, options?: ListBlobsOptions): Promise<ListBlobsResult>;
  deleteBlobMeta(spaceUri: string, cid: string): Promise<void>;
  /** Find blob rows older than `cutoff` whose CIDs are not referenced in any
   *  record JSON in this space. Capped at `limit` to bound a single GC pass. */
  findOrphanBlobs(spaceUri: string, cutoff: number, limit: number): Promise<BlobMetaRow[]>;
}

/** Combined adapter. Used internally where a single object satisfies both
 *  roles (today's HostedAdapter, the community reconciler, the realtime
 *  publishing wrapper). Phases 5+ replace consumers of this with two
 *  injected interfaces. */
export type StorageAdapter = SpaceAuthority & RecordHost;

export interface AdapterContext {
  db: Database;
}
