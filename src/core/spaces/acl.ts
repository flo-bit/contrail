import type { AppPolicy, MemberPerm, SpaceMemberRow, SpaceRow } from "./types";

export type AclOp = "read" | "write" | "delete";

export interface AclInput {
  op: AclOp;
  space: SpaceRow;
  callerDid: string;
  /** Membership row for the caller (or null). Owner does not require a row. */
  member: SpaceMemberRow | null;
  /** OAuth client_id of the app calling on caller's behalf, for app policy checks. */
  clientId?: string;
  /** For per-record ops (get/delete), the record's author DID. */
  targetAuthorDid?: string;
}

export type AclResult =
  | { allow: true }
  | { allow: false; reason: AclDenyReason };

export type AclDenyReason =
  | "not-member"
  | "not-writer"
  | "not-own-record"
  | "app-not-allowed"
  | "unknown-op";

/** Check whether the caller's app is permitted to act in this space. */
export function checkAppPolicy(
  appPolicy: AppPolicy | null,
  clientId: string | undefined
): boolean {
  if (!appPolicy) return true; // no policy = allow-all
  const listed = clientId ? appPolicy.apps.includes(clientId) : false;
  if (appPolicy.mode === "allow") return !listed; // apps[] is a denylist
  return listed; // mode === "deny": apps[] is an allowlist
}

const isOwner = (space: SpaceRow, did: string) => space.ownerDid === did;
const hasMember = (space: SpaceRow, member: SpaceMemberRow | null, did: string) =>
  isOwner(space, did) || member != null;
const hasWrite = (space: SpaceRow, member: SpaceMemberRow | null, did: string) =>
  isOwner(space, did) || member?.perms === "write";

/** Space-level access check.
 *  Model matches the proposal: member list is a (DID, perm) tuple set per space;
 *  write implies read; owner is always implicit write. No per-collection
 *  policies — all records in a space share the same access rule. */
export function checkAccess(input: AclInput): AclResult {
  if (!checkAppPolicy(input.space.appPolicy, input.clientId)) {
    return { allow: false, reason: "app-not-allowed" };
  }

  if (input.op === "read") {
    return hasMember(input.space, input.member, input.callerDid)
      ? { allow: true }
      : { allow: false, reason: "not-member" };
  }

  if (input.op === "write") {
    return hasWrite(input.space, input.member, input.callerDid)
      ? { allow: true }
      : { allow: false, reason: "not-writer" };
  }

  if (input.op === "delete") {
    if (isOwner(input.space, input.callerDid)) return { allow: true };
    if (!hasWrite(input.space, input.member, input.callerDid)) {
      return { allow: false, reason: "not-writer" };
    }
    if (input.targetAuthorDid && input.targetAuthorDid !== input.callerDid) {
      return { allow: false, reason: "not-own-record" };
    }
    return { allow: true };
  }

  return { allow: false, reason: "unknown-op" };
}

export type MemberPermExport = MemberPerm;
