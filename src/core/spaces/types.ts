import type { Database } from "../types";
import type { DidDocumentResolver } from "@atcute/identity-resolver";
import type { BlobAdapter } from "./blob-adapter";

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

export interface SpacesConfig {
  /** NSID that identifies the kind of space this service hosts, e.g. "tools.atmo.event.space". */
  type: string;
  /** Service DID that service-auth tokens must target (aud claim). */
  serviceDid: string;
  /** Default app policy applied to new spaces. */
  defaultAppPolicy?: AppPolicy;
  /** DID document resolver for service-auth JWT verification.
   *  Defaults to a composite PLC + did:web resolver if omitted. */
  resolver?: DidDocumentResolver;
  /** Blob-upload backend. When omitted, blob XRPCs are not exposed. */
  blobs?: SpacesBlobsConfig;
  /** Dev-only auth bypass. Runs BEFORE JWT verification. If it returns
   *  non-null claims, those are used as the authenticated caller and the
   *  JWT check is skipped. Intended for local development where bsky.social
   *  rejects `getServiceAuth` for loopback OAuth clients; pair with a
   *  signed-cookie session check so only your own browser can trigger it.
   *  Never set in production. */
  authOverride?: (
    req: Request
  ) => Promise<AuthOverrideResult | null> | AuthOverrideResult | null;
}

/** Claims returned by an `authOverride`. Matches the ServiceAuth shape the
 *  normal JWT path attaches to the request. */
export interface AuthOverrideResult {
  issuer: string;
  audience?: string;
  lxm?: string;
  clientId?: string;
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

export interface ListBlobsOptions {
  byUser?: string;
  cursor?: string;
  limit?: number;
}

export interface ListBlobsResult {
  blobs: BlobMetaRow[];
  cursor?: string;
}

export interface StorageAdapter {
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

  // Invites
  createInvite(input: CreateInviteInput): Promise<InviteRow>;
  listInvites(spaceUri: string, options?: { includeRevoked?: boolean }): Promise<InviteRow[]>;
  revokeInvite(tokenHash: string): Promise<boolean>;
  /** Look up an invite without consuming it. Used to validate read-token bearer access. */
  getInvite(tokenHash: string): Promise<InviteRow | null>;
  /** Atomically mark a join-capable invite as used. Returns the row if usable
   *  (kind allows join, not expired/revoked/exhausted), null otherwise. */
  redeemInvite(tokenHash: string, now: number): Promise<InviteRow | null>;

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

export interface AdapterContext {
  db: Database;
}
