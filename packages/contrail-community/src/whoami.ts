/** Whoami extension that adds `accessLevel` (and the corrected `isMember`)
 *  for community-owned spaces. Returns null for non-community spaces so the
 *  spaces module's default binary-membership logic runs. */

import type { WhoamiExtension } from "@atmo-dev/contrail";
import type { CommunityAdapter } from "./adapter";
import { resolveEffectiveLevel } from "./acl";

export function createCommunityWhoamiExtension(args: {
  community: CommunityAdapter;
}): WhoamiExtension {
  const { community } = args;
  return async ({ spaceUri, callerDid, isOwner, ownerDid }) => {
    const isCommunity = !!(await community.getCommunity(ownerDid));
    if (!isCommunity) return null;

    // The reconciler keeps spaces_members in sync with the access-level
    // ladder, so isMember derives from the effective level directly.
    const level = await resolveEffectiveLevel(community, spaceUri, callerDid);
    return {
      isOwner,
      isMember: isOwner || !!level,
      accessLevel: level,
    };
  };
}
