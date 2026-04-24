/** Unified invite surface: a single `<ns>.invite.*` family serving both
 *  user-owned and community-owned spaces. Dispatches on space ownership.
 *
 *    - User-owned space  → `kind` in create, `addMember` on redeem, owner-only.
 *    - Community-owned   → `accessLevel` in create, `grant` on redeem,
 *                          manager+ with "cannot grant higher than self".
 *
 *  Storage stays separate (`spaces_invites` vs `community_invites` tables) —
 *  schemas differ enough that unifying them would be net-negative. The token
 *  primitive and HTTP dance are shared. */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContrailConfig } from "../types";
import type { ServiceAuth } from "../spaces/auth";
import type { StorageAdapter } from "../spaces/types";
import type { InviteKind, InviteRow } from "../spaces/types";
import type { CommunityAdapter } from "../community/adapter";
import type { CommunityInviteRow, AccessLevel } from "../community/types";
import { isAccessLevel, rankOf } from "../community/types";
import { hashInviteToken, mintInviteToken } from "./token";
import { resolveEffectiveLevel } from "../community/acl";
import { reconcile } from "../community/reconcile";

export interface InviteRoutesOptions {
  authMiddleware: MiddlewareHandler;
}

/** Shape returned to clients — `kind` (user-owned space) or `accessLevel`
 *  (community-owned space) is set, never both. */
interface PublicInviteView {
  tokenHash: string;
  spaceUri: string;
  kind?: InviteKind;
  accessLevel?: AccessLevel;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: number | null;
  note: string | null;
}

function toSpacesView(row: InviteRow): PublicInviteView {
  return {
    tokenHash: row.tokenHash,
    spaceUri: row.spaceUri,
    kind: row.kind,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    revokedAt: row.revokedAt,
    note: row.note,
  };
}

function toCommunityView(row: CommunityInviteRow): PublicInviteView {
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

export function registerInviteRoutes(
  app: Hono,
  config: ContrailConfig,
  spaces: StorageAdapter,
  community: CommunityAdapter | null,
  options: InviteRoutesOptions
): void {
  if (!config.spaces) return;

  const NS = `${config.namespace}.invite`;
  const auth = options.authMiddleware;

  /** Resolve whether a space is community-owned. Returns null if the space
   *  doesn't exist. */
  const classifySpace = async (spaceUri: string) => {
    const space = await spaces.getSpace(spaceUri);
    if (!space) return null;
    const isCommunity = community ? !!(await community.getCommunity(space.ownerDid)) : false;
    return { space, isCommunity };
  };

  app.post(`/xrpc/${NS}.create`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | {
          spaceUri?: string;
          kind?: string;
          accessLevel?: string;
          expiresAt?: number;
          maxUses?: number;
          note?: string;
        }
      | null;
    if (!body?.spaceUri) {
      return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    }
    if (body.kind && body.accessLevel) {
      return c.json(
        { error: "InvalidRequest", reason: "kind-or-accessLevel", message: "pass kind OR accessLevel, not both" },
        400
      );
    }

    const classified = await classifySpace(body.spaceUri);
    if (!classified) return c.json({ error: "NotFound" }, 404);
    const { space, isCommunity } = classified;

    if (isCommunity) {
      if (!community) return c.json({ error: "InvalidState" }, 500);
      if (body.kind) {
        return c.json(
          { error: "InvalidRequest", reason: "kind-on-community-space", message: "community spaces take accessLevel, not kind" },
          400
        );
      }
      if (!body.accessLevel || !isAccessLevel(body.accessLevel)) {
        return c.json({ error: "InvalidRequest", reason: "accessLevel-required" }, 400);
      }
      // Caller must have manager+ on the target space and cannot create an
      // invite that confers a higher level than their own.
      const callerLevel = await resolveEffectiveLevel(community, body.spaceUri, sa.issuer);
      if (!callerLevel || rankOf(callerLevel) < rankOf("manager")) {
        return c.json({ error: "Forbidden", reason: "manager-required" }, 403);
      }
      if (rankOf(body.accessLevel) > rankOf(callerLevel)) {
        return c.json({ error: "Forbidden", reason: "cannot-grant-higher-than-self" }, 403);
      }
      const { token, tokenHash } = await mintInviteToken();
      const row = await community.createInvite({
        spaceUri: body.spaceUri,
        tokenHash,
        accessLevel: body.accessLevel,
        createdBy: sa.issuer,
        expiresAt: body.expiresAt ?? null,
        maxUses: body.maxUses ?? null,
        note: body.note ?? null,
      });
      return c.json({ token, invite: toCommunityView(row) });
    }

    // User-owned space.
    if (body.accessLevel) {
      return c.json(
        { error: "InvalidRequest", reason: "accessLevel-on-user-space", message: "user-owned spaces take kind, not accessLevel" },
        400
      );
    }
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    const kind = (body.kind ?? "join") as InviteKind;
    if (kind !== "join" && kind !== "read" && kind !== "read-join") {
      return c.json({ error: "InvalidRequest", message: "kind must be 'join', 'read', or 'read-join'" }, 400);
    }
    const { token, tokenHash } = await mintInviteToken();
    const invite = await spaces.createInvite({
      spaceUri: body.spaceUri,
      tokenHash,
      kind,
      expiresAt: body.expiresAt ?? null,
      maxUses: body.maxUses ?? null,
      createdBy: sa.issuer,
      note: body.note ?? null,
    });
    return c.json({ token, invite: toSpacesView(invite) });
  });

  app.get(`/xrpc/${NS}.list`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    if (!spaceUri) return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    const includeRevoked = c.req.query("includeRevoked") === "true";

    const classified = await classifySpace(spaceUri);
    if (!classified) return c.json({ error: "NotFound" }, 404);
    const { space, isCommunity } = classified;

    if (isCommunity) {
      const callerLevel = await resolveEffectiveLevel(community!, spaceUri, sa.issuer);
      if (!callerLevel || rankOf(callerLevel) < rankOf("manager")) {
        return c.json({ error: "Forbidden", reason: "manager-required" }, 403);
      }
      const rows = await community!.listInvites(spaceUri, { includeRevoked });
      return c.json({ invites: rows.map(toCommunityView) });
    }

    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    const rows = await spaces.listInvites(spaceUri, { includeRevoked });
    return c.json({ invites: rows.map(toSpacesView) });
  });

  app.post(`/xrpc/${NS}.revoke`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; tokenHash?: string }
      | null;
    if (!body?.tokenHash) {
      return c.json({ error: "InvalidRequest", message: "tokenHash required" }, 400);
    }

    // When the caller passes spaceUri we do an auth check up front so the
    // response doesn't leak token existence. Community revokers may also be
    // the invite creator (even without manager+), which is resolved after.
    if (body.spaceUri) {
      const classified = await classifySpace(body.spaceUri);
      if (!classified) return c.json({ error: "NotFound" }, 404);
      if (classified.isCommunity) {
        const level = await resolveEffectiveLevel(community!, body.spaceUri, sa.issuer);
        const managerOrHigher = !!level && rankOf(level) >= rankOf("manager");
        if (!managerOrHigher) {
          const crow = await community!.getInvite(body.tokenHash);
          if (!crow || crow.createdBy !== sa.issuer) {
            return c.json({ error: "Forbidden", reason: "creator-or-manager-required" }, 403);
          }
        }
        const ok = await community!.revokeInvite(body.tokenHash);
        return c.json({ ok });
      }
      if (classified.space.ownerDid !== sa.issuer) {
        return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
      }
      const ok = await spaces.revokeInvite(body.tokenHash);
      return c.json({ ok });
    }

    // No spaceUri provided — infer from the invite row.
    if (community) {
      const crow = await community.getInvite(body.tokenHash);
      if (crow) {
        let allowed = crow.createdBy === sa.issuer;
        if (!allowed) {
          const level = await resolveEffectiveLevel(community, crow.spaceUri, sa.issuer);
          allowed = !!level && rankOf(level) >= rankOf("manager");
        }
        if (!allowed) {
          return c.json({ error: "Forbidden", reason: "creator-or-manager-required" }, 403);
        }
        const ok = await community.revokeInvite(body.tokenHash);
        return c.json({ ok });
      }
    }
    const srow = await spaces.getInvite(body.tokenHash);
    if (!srow) return c.json({ error: "NotFound" }, 404);
    const space = await spaces.getSpace(srow.spaceUri);
    if (space && space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    const ok = await spaces.revokeInvite(body.tokenHash);
    return c.json({ ok });
  });

  app.post(`/xrpc/${NS}.redeem`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
    if (!body?.token) {
      return c.json({ error: "InvalidRequest", message: "token required" }, 400);
    }
    const tokenHash = await hashInviteToken(body.token);
    const now = Date.now();

    // Try community first (it's atomic — returns null if not consumable).
    if (community) {
      const cinvite = await community.redeemInvite(tokenHash, now);
      if (cinvite) {
        const space = await spaces.getSpace(cinvite.spaceUri);
        if (!space) {
          return c.json({ error: "NotFound", reason: "space-not-found" }, 404);
        }
        // The token itself is the authorization: creator (manager+) pre-signed
        // "anyone with this token gets level X". Grant directly, attributing
        // to the creator so audit trails make sense.
        await community.grant({
          spaceUri: cinvite.spaceUri,
          subjectDid: sa.issuer,
          accessLevel: cinvite.accessLevel,
          grantedBy: cinvite.createdBy,
        });
        await reconcile(community, spaces, cinvite.spaceUri, cinvite.createdBy);
        return c.json({
          spaceUri: cinvite.spaceUri,
          accessLevel: cinvite.accessLevel,
          communityDid: space.ownerDid,
        });
      }
    }

    // Fall back to the spaces (user-owned) path. The spaces redeem filter
    // already restricts to `kind IN ('join','read-join')` at the SQL level.
    const sinvite = await spaces.redeemInvite(tokenHash, now);
    if (!sinvite) {
      return c.json({ error: "InvalidInvite", reason: "expired-revoked-or-exhausted" }, 400);
    }
    await spaces.addMember(sinvite.spaceUri, sa.issuer, sinvite.createdBy);
    return c.json({ spaceUri: sinvite.spaceUri, kind: sinvite.kind });
  });
}

function getAuth(c: Context): ServiceAuth {
  const a = c.get("serviceAuth") as ServiceAuth | undefined;
  if (!a) throw new Error("service auth not set");
  return a;
}
