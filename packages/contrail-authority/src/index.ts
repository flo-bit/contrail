/** @atmo-dev/contrail-authority — default space-authority implementation.
 *
 *  Owns the authority-side adapter (member list, invites, app policy, space
 *  lifecycle, credential issuance), DDL, and route registration. */

export {
  HostedAuthorityAdapter,
  parseJson,
  toNum,
  mapSpaceRow,
  mapMemberRow,
  mapInviteRow,
} from "./adapter";

export {
  buildAuthoritySchema,
  applyAuthoritySchema,
} from "./schema";

export { registerAuthorityRoutes } from "./routes";

export { registerInviteRoutes } from "./invite-routes";
export type { InviteRoutesOptions } from "./invite-routes";
