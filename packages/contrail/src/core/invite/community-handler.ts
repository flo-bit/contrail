/** Pluggable handler for community-grant invites within the unified invite
 *  surface. The invite router calls into this when the target space is
 *  community-owned, or "tries" it on the redeem / revoke-without-spaceUri
 *  paths. Community module provides the impl; invite/router doesn't import
 *  from community at all.
 *
 *  Each method returns a `HandlerResponse`: a `{status, body}` envelope that
 *  the router relays as JSON, or `null` (only on the "try" methods) meaning
 *  "not applicable, fall through to the user-owned path." */

export type HandlerResponse = {
  status: number;
  body: Record<string, unknown>;
};

export interface CommunityInviteHandler {
  /** True iff this space is owned by a community (vs. a regular user DID).
   *  Used by the invite router to choose the dispatch path on
   *  create / list / revoke-with-spaceUri. */
  isCommunityOwned(spaceUri: string): Promise<boolean>;

  /** Create a community-grant invite. Caller is validated upstream for
   *  having a JWT; this method handles the access-level checks. */
  create(input: {
    spaceUri: string;
    callerDid: string;
    /** Raw caller-supplied access level — implementation validates. */
    accessLevel?: string;
    /** Caller-supplied `kind` field — community spaces don't accept this; the
     *  handler returns an InvalidRequest if set. */
    kind?: string;
    expiresAt: number | null;
    maxUses: number | null;
    note: string | null;
  }): Promise<HandlerResponse>;

  /** List invites for a community-owned space. */
  list(input: {
    spaceUri: string;
    callerDid: string;
    includeRevoked: boolean;
  }): Promise<HandlerResponse>;

  /** Revoke a known community-owned invite (caller already passed spaceUri
   *  and the router classified it as community-owned). */
  revoke(input: {
    spaceUri: string;
    tokenHash: string;
    callerDid: string;
  }): Promise<HandlerResponse>;

  /** Revoke without a spaceUri — try to find the invite in the community
   *  table; return null if not a community invite (router falls through). */
  tryRevokeByToken(input: {
    tokenHash: string;
    callerDid: string;
  }): Promise<HandlerResponse | null>;

  /** Try to redeem a token as a community invite. Returns null if the token
   *  is not a community invite, in which case the router falls through to
   *  the user-owned redeem path. */
  tryRedeem(input: {
    tokenHash: string;
    callerDid: string;
    now: number;
  }): Promise<HandlerResponse | null>;
}
