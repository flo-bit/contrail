/** Implementation of {@link CommunityInviteHandler} for community-grant
 *  invites. Lives here (not in invite/) so the dependency edge points
 *  community → invite (downward), not the other way around. */

import type {
  CommunityInviteHandler,
  HandlerResponse,
} from "../invite/community-handler";
import { mintInviteToken } from "../invite/token";
import type { CommunityAdapter } from "./adapter";
import type { SpaceAuthority } from "../spaces/types";
import { resolveEffectiveLevel } from "./acl";
import { reconcile } from "./reconcile";
import type { AccessLevel, CommunityInviteRow } from "./types";
import { isAccessLevel, rankOf } from "./types";

interface PublicInviteView {
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

function toView(row: CommunityInviteRow): PublicInviteView {
  return {
    tokenHash: row.tokenHash,
    spaceUri: row.spaceUri,
    accessLevel: row.accessLevel,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    revokedAt: row.revokedAt,
    note: row.note,
  };
}

const ok = (body: Record<string, unknown>): HandlerResponse => ({ status: 200, body });
const err = (status: number, body: Record<string, unknown>): HandlerResponse => ({ status, body });

export function createCommunityInviteHandler(args: {
  community: CommunityAdapter;
  /** Space authority — used to look up space metadata after redemption (e.g.
   *  to return the community DID). */
  authority: SpaceAuthority;
}): CommunityInviteHandler {
  const { community, authority } = args;

  return {
    async isCommunityOwned(spaceUri) {
      const space = await authority.getSpace(spaceUri);
      if (!space) return false;
      return !!(await community.getCommunity(space.ownerDid));
    },

    async create(input) {
      if (input.kind) {
        return err(400, {
          error: "InvalidRequest",
          reason: "kind-on-community-space",
          message: "community spaces take accessLevel, not kind",
        });
      }
      if (!input.accessLevel || !isAccessLevel(input.accessLevel)) {
        return err(400, { error: "InvalidRequest", reason: "accessLevel-required" });
      }
      const callerLevel = await resolveEffectiveLevel(community, input.spaceUri, input.callerDid);
      if (!callerLevel || rankOf(callerLevel) < rankOf("manager")) {
        return err(403, { error: "Forbidden", reason: "manager-required" });
      }
      if (rankOf(input.accessLevel) > rankOf(callerLevel)) {
        return err(403, { error: "Forbidden", reason: "cannot-grant-higher-than-self" });
      }
      const { token, tokenHash } = await mintInviteToken();
      const row = await community.createInvite({
        spaceUri: input.spaceUri,
        tokenHash,
        accessLevel: input.accessLevel,
        createdBy: input.callerDid,
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
        note: input.note,
      });
      return ok({ token, invite: toView(row) });
    },

    async list(input) {
      const callerLevel = await resolveEffectiveLevel(community, input.spaceUri, input.callerDid);
      if (!callerLevel || rankOf(callerLevel) < rankOf("manager")) {
        return err(403, { error: "Forbidden", reason: "manager-required" });
      }
      const rows = await community.listInvites(input.spaceUri, {
        includeRevoked: input.includeRevoked,
      });
      return ok({ invites: rows.map(toView) });
    },

    async revoke(input) {
      const level = await resolveEffectiveLevel(community, input.spaceUri, input.callerDid);
      const managerOrHigher = !!level && rankOf(level) >= rankOf("manager");
      if (!managerOrHigher) {
        const crow = await community.getInvite(input.tokenHash);
        if (!crow || crow.createdBy !== input.callerDid) {
          return err(403, { error: "Forbidden", reason: "creator-or-manager-required" });
        }
      }
      const revoked = await community.revokeInvite(input.tokenHash);
      return ok({ ok: revoked });
    },

    async tryRevokeByToken(input) {
      const crow = await community.getInvite(input.tokenHash);
      if (!crow) return null;
      let allowed = crow.createdBy === input.callerDid;
      if (!allowed) {
        const level = await resolveEffectiveLevel(community, crow.spaceUri, input.callerDid);
        allowed = !!level && rankOf(level) >= rankOf("manager");
      }
      if (!allowed) {
        return err(403, { error: "Forbidden", reason: "creator-or-manager-required" });
      }
      const revoked = await community.revokeInvite(input.tokenHash);
      return ok({ ok: revoked });
    },

    async tryRedeem(input) {
      const cinvite = await community.redeemInvite(input.tokenHash, input.now);
      if (!cinvite) return null;
      const space = await authority.getSpace(cinvite.spaceUri);
      if (!space) return err(404, { error: "NotFound", reason: "space-not-found" });
      // The token itself is the authorization: creator (manager+) pre-signed
      // "anyone with this token gets level X". Grant directly, attributing
      // to the creator so audit trails make sense.
      await community.grant({
        spaceUri: cinvite.spaceUri,
        subjectDid: input.callerDid,
        accessLevel: cinvite.accessLevel,
        grantedBy: cinvite.createdBy,
      });
      await reconcile(community, authority, cinvite.spaceUri, cinvite.createdBy);
      return ok({
        spaceUri: cinvite.spaceUri,
        accessLevel: cinvite.accessLevel,
        communityDid: space.ownerDid,
      });
    },
  };
}
