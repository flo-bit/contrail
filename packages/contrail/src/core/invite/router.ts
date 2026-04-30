/** Unified invite surface: a single `<ns>.invite.*` family serving both
 *  user-owned and community-owned spaces. Dispatches on space ownership.
 *
 *    - User-owned space  → `kind` in create, `addMember` on redeem, owner-only.
 *    - Community-owned   → routed to a {@link CommunityInviteHandler} provided
 *                          by the community module (or null when community is
 *                          not configured).
 *
 *  Storage stays separate (`spaces_invites` vs `community_invites` tables) —
 *  schemas differ enough that unifying them would be net-negative. The token
 *  primitive and HTTP dance are shared. invite/router has zero imports from
 *  community/ — coupling is via the {@link CommunityInviteHandler} interface. */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContrailConfig } from "../types";
import type { ServiceAuth } from "../spaces/auth";
import type { SpaceAuthority } from "../spaces/types";
import type { InviteKind, InviteRow } from "../spaces/types";
import { hashInviteToken, mintInviteToken } from "./token";
import type { CommunityInviteHandler, HandlerResponse } from "./community-handler";

export interface InviteRoutesOptions {
  authMiddleware: MiddlewareHandler;
}

interface PublicInviteView {
  tokenHash: string;
  spaceUri: string;
  kind?: InviteKind;
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

export function registerInviteRoutes(
  app: Hono,
  config: ContrailConfig,
  authority: SpaceAuthority,
  community: CommunityInviteHandler | null,
  options: InviteRoutesOptions
): void {
  if (!config.spaces?.authority) return;

  const NS = `${config.namespace}.invite`;
  const auth = options.authMiddleware;

  /** Resolve whether a space is community-owned. Returns null if the space
   *  doesn't exist. */
  const classifySpace = async (spaceUri: string) => {
    const space = await authority.getSpace(spaceUri);
    if (!space) return null;
    const isCommunity = community ? await community.isCommunityOwned(spaceUri) : false;
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
      return relay(c, await community.create({
        spaceUri: body.spaceUri,
        callerDid: sa.issuer,
        accessLevel: body.accessLevel,
        kind: body.kind,
        expiresAt: body.expiresAt ?? null,
        maxUses: body.maxUses ?? null,
        note: body.note ?? null,
      }));
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
    const invite = await authority.createInvite({
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
      return relay(c, await community!.list({
        spaceUri,
        callerDid: sa.issuer,
        includeRevoked,
      }));
    }

    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    const rows = await authority.listInvites(spaceUri, { includeRevoked });
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

    if (body.spaceUri) {
      const classified = await classifySpace(body.spaceUri);
      if (!classified) return c.json({ error: "NotFound" }, 404);
      if (classified.isCommunity) {
        return relay(c, await community!.revoke({
          spaceUri: body.spaceUri,
          tokenHash: body.tokenHash,
          callerDid: sa.issuer,
        }));
      }
      if (classified.space.ownerDid !== sa.issuer) {
        return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
      }
      const ok = await authority.revokeInvite(body.tokenHash);
      return c.json({ ok });
    }

    // No spaceUri — try the community handler first (it returns null if the
    // token isn't a community invite), then fall back to the user-owned path.
    if (community) {
      const r = await community.tryRevokeByToken({
        tokenHash: body.tokenHash,
        callerDid: sa.issuer,
      });
      if (r) return relay(c, r);
    }
    const srow = await authority.getInvite(body.tokenHash);
    if (!srow) return c.json({ error: "NotFound" }, 404);
    const space = await authority.getSpace(srow.spaceUri);
    if (space && space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    const ok = await authority.revokeInvite(body.tokenHash);
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

    // Try community first (atomic — null if not a community invite).
    if (community) {
      const r = await community.tryRedeem({
        tokenHash,
        callerDid: sa.issuer,
        now,
      });
      if (r) return relay(c, r);
    }

    // Fall back to the user-owned spaces path. The redeem filter at the SQL
    // level already restricts to `kind IN ('join','read-join')`.
    const sinvite = await authority.redeemInvite(tokenHash, now);
    if (!sinvite) {
      return c.json({ error: "InvalidInvite", reason: "expired-revoked-or-exhausted" }, 400);
    }
    await authority.addMember(sinvite.spaceUri, sa.issuer, sinvite.createdBy);
    return c.json({ spaceUri: sinvite.spaceUri, kind: sinvite.kind });
  });
}

/** Forward a community-handler response to the wire. */
function relay(c: Context, r: HandlerResponse) {
  return c.json(r.body, r.status as Parameters<typeof c.json>[1]);
}

function getAuth(c: Context): ServiceAuth {
  const a = c.get("serviceAuth") as ServiceAuth | undefined;
  if (!a) throw new Error("service auth not set");
  return a;
}
