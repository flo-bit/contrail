import type { Database } from "../types";
import type { DidDocumentResolver } from "@atcute/identity-resolver";

/** Member permission in a space. "write" implies "read"; owner is always implicit write. */
export type MemberPerm = "read" | "write";

export type AppPolicyMode = "allow" | "deny";

export interface AppPolicy {
  mode: AppPolicyMode;
  apps: string[];
}

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
}

export interface SpaceRow {
  uri: string;
  ownerDid: string;
  type: string;
  key: string;
  serviceDid: string;
  memberListRef: string | null;
  appPolicyRef: string | null;
  appPolicy: AppPolicy | null;
  createdAt: number;
  deletedAt: number | null;
}

export interface SpaceMemberRow {
  spaceUri: string;
  did: string;
  perms: MemberPerm;
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
 *  - `'join'`: must be redeemed while signed in; becomes a member with `perms`.
 *  - `'read'`: bearer-only — token itself grants read access to the space; cannot be redeemed.
 *  - `'read-join'`: both — anonymous holders read; signed-in holders may also redeem to join. */
export type InviteKind = "join" | "read" | "read-join";

export interface InviteRow {
  tokenHash: string;
  spaceUri: string;
  kind: InviteKind;
  perms: MemberPerm;
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
  perms: MemberPerm;
  expiresAt: number | null;
  maxUses: number | null;
  createdBy: string;
  note: string | null;
}

export interface RedeemInviteResult {
  spaceUri: string;
  perms: MemberPerm;
}

export interface StorageAdapter {
  // Space lifecycle
  createSpace(space: Omit<SpaceRow, "createdAt" | "deletedAt">): Promise<SpaceRow>;
  getSpace(spaceUri: string): Promise<SpaceRow | null>;
  listSpaces(options: ListSpacesOptions): Promise<{ spaces: SpaceRow[]; cursor?: string }>;
  deleteSpace(spaceUri: string): Promise<void>;
  updateSpaceAppPolicy(spaceUri: string, appPolicy: AppPolicy): Promise<void>;
  /** Update ownerDid of a space. Membership rows are not touched; callers are
   *  responsible for ensuring the new owner is already a write member. */
  transferOwnership(spaceUri: string, newOwnerDid: string): Promise<SpaceRow | null>;

  // Members
  addMember(spaceUri: string, did: string, perms: MemberPerm, addedBy: string | null): Promise<void>;
  removeMember(spaceUri: string, did: string): Promise<void>;
  getMember(spaceUri: string, did: string): Promise<SpaceMemberRow | null>;
  listMembers(spaceUri: string): Promise<SpaceMemberRow[]>;

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
}

export interface AdapterContext {
  db: Database;
}
