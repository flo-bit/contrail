import type { AppPolicy, SpaceMemberRow, SpaceRow } from "./types";

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

/** Space-level access check.
 *  Membership = access. Any member can read and write; the app filters
 *  writes it doesn't want on its own side. Delete keeps the owner/own-record
 *  rule so a random member can't nuke other people's records. */
export function checkAccess(input: AclInput): AclResult {
  if (!checkAppPolicy(input.space.appPolicy, input.clientId)) {
    return { allow: false, reason: "app-not-allowed" };
  }

  if (input.op === "read" || input.op === "write") {
    return hasMember(input.space, input.member, input.callerDid)
      ? { allow: true }
      : { allow: false, reason: "not-member" };
  }

  if (input.op === "delete") {
    if (isOwner(input.space, input.callerDid)) return { allow: true };
    if (!hasMember(input.space, input.member, input.callerDid)) {
      return { allow: false, reason: "not-member" };
    }
    if (input.targetAuthorDid && input.targetAuthorDid !== input.callerDid) {
      return { allow: false, reason: "not-own-record" };
    }
    return { allow: true };
  }

  return { allow: false, reason: "unknown-op" };
}
