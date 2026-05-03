/** Authority XRPC routes — space lifecycle, members, app policy, whoami,
 *  credential issuance. Does NOT touch records or blobs.
 *
 *  Deployments wire this via `registerAuthorityRoutes(app, authority, ...)`.
 *  The umbrella `registerSpacesRoutes` in @atmo-dev/contrail composes this
 *  with the record-host routes; split deployments call this directly. */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type {
  AuthorityConfig,
  ContrailConfig,
  CredentialClaims,
  RecordHost,
  ServiceAuth,
  SpaceAuthority,
  SpaceRow,
  WhoamiExtension,
} from "@atmo-dev/contrail-base";
import {
  buildSpaceUri,
  checkInviteReadGrant,
  decodeUnverifiedClaims,
  DEFAULT_CREDENTIAL_TTL_MS,
  DEFAULT_MANIFEST_TTL_MS,
  extractInviteToken,
  hashInviteToken,
  issueCredential,
  issueMembershipManifest,
  nextTid,
  verifyCredential,
} from "@atmo-dev/contrail-base";

/** When `localRecordHost` is non-null, the authority's `createSpace` handler
 *  also enrolls the new space on that host — convenient for in-process
 *  deployments where the same operator runs both roles. Split deployments
 *  pass `null` and arrange enrollment explicitly via `recordHost.enroll`. */
export function registerAuthorityRoutes(
  app: Hono,
  authority: SpaceAuthority,
  authorityConfig: AuthorityConfig,
  config: ContrailConfig,
  auth: MiddlewareHandler,
  whoamiExtension?: WhoamiExtension,
  localRecordHost?: RecordHost | null
): void {
  /** Space endpoints are emitted per-deployment under the configured namespace;
   *  the deployment owns and publishes its own lexicons. */
  const SPACE = `${config.namespace}.space`;
  const SPACE_EXT = `${config.namespace}.spaceExt`;

  // ---- Read endpoints ----

  app.get(`/xrpc/${SPACE}.listSpaces`, auth, async (c) => {
    const sa = getAuth(c);
    const scope = c.req.query("scope") ?? "member";
    const type = c.req.query("type") ?? undefined;
    const owner = c.req.query("owner") ?? undefined;
    const cursor = c.req.query("cursor") ?? undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

    const opts: Parameters<typeof authority.listSpaces>[0] = { type, cursor, limit };
    if (scope === "owner") opts.ownerDid = sa.issuer;
    else {
      opts.memberDid = sa.issuer;
      if (owner) opts.ownerDid = owner;
    }

    const result = await authority.listSpaces(opts);
    return c.json({
      spaces: result.spaces.map((s) => publicSpaceView(s, s.ownerDid === sa.issuer)),
      cursor: result.cursor,
    });
  });

  app.get(`/xrpc/${SPACE}.listMembers`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    if (!spaceUri) return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    const space = await authority.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const isOwner = space.ownerDid === sa.issuer;
    const member = isOwner ? null : await authority.getMember(spaceUri, sa.issuer);
    if (!isOwner && !member) {
      return c.json({ error: "Forbidden", reason: "not-member" }, 403);
    }
    const members = await authority.listMembers(spaceUri);
    return c.json({ members });
  });

  /** Read-route auth: skip the JWT middleware when an `?inviteToken=` is
   *  present so anonymous bearer reads don't 401 before the route handler can
   *  validate the token. */
  const readAuth: MiddlewareHandler = async (c, next) => {
    if (extractInviteToken(c.req.raw)) {
      await next();
      return;
    }
    return auth(c, next);
  };

  app.get(`/xrpc/${SPACE}.getSpace`, readAuth, async (c) => {
    const uri = c.req.query("uri");
    if (!uri) return c.json({ error: "InvalidRequest", message: "uri required" }, 400);
    const space = await authority.getSpace(uri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const authz = await authorizeRead(c, authority, uri);
    if (authz instanceof Response) return authz;

    if (authz.via === "token") {
      return c.json({ space: publicSpaceView(space, false) });
    }

    if (authz.via === "credential") {
      const isOwner = authz.claims.sub === space.ownerDid;
      return c.json({ space: publicSpaceView(space, isOwner) });
    }

    const sa = authz.sa;
    const isOwner = sa.issuer === space.ownerDid;
    const member = isOwner ? null : await authority.getMember(uri, sa.issuer);
    if (!isOwner && !member) {
      return c.json({ error: "Forbidden", reason: "not-member" }, 403);
    }
    return c.json({ space: publicSpaceView(space, isOwner) });
  });

  // ---- Space management (owner-gated) ----

  app.post(`/xrpc/${SPACE}.createSpace`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      type?: string;
      key?: string;
      appPolicy?: SpaceRow["appPolicy"];
      appPolicyRef?: string;
    };

    const type = body.type ?? authorityConfig.type;
    const key = body.key ?? nextTid();
    const uri = buildSpaceUri({ ownerDid: sa.issuer, type, key });

    const existing = await authority.getSpace(uri);
    if (existing) return c.json({ error: "AlreadyExists", uri }, 409);

    const space = await authority.createSpace({
      uri,
      ownerDid: sa.issuer,
      type,
      key,
      serviceDid: authorityConfig.serviceDid,
      appPolicyRef: body.appPolicyRef ?? null,
      appPolicy: body.appPolicy ?? authorityConfig.defaultAppPolicy ?? null,
    });
    await authority.addMember(uri, sa.issuer, sa.issuer);

    if (localRecordHost) {
      await localRecordHost.enroll({
        spaceUri: uri,
        authorityDid: authorityConfig.serviceDid,
        enrolledAt: Date.now(),
        enrolledBy: sa.issuer,
      });
    }

    return c.json({ space: publicSpaceView(space, true) });
  });

  app.post(`/xrpc/${SPACE}.addMember`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; did?: string }
      | null;
    if (!body?.spaceUri || !body.did) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and did required" }, 400);
    }
    const space = await authority.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    await authority.addMember(body.spaceUri, body.did, sa.issuer);
    return c.json({ ok: true });
  });

  app.post(`/xrpc/${SPACE}.removeMember`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; did?: string }
      | null;
    if (!body?.spaceUri || !body.did) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and did required" }, 400);
    }
    const space = await authority.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    if (body.did === space.ownerDid) {
      return c.json({ error: "InvalidRequest", reason: "cannot-remove-owner" }, 400);
    }
    await authority.removeMember(body.spaceUri, body.did);
    return c.json({ ok: true });
  });

  app.post(`/xrpc/${SPACE}.leaveSpace`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as { spaceUri?: string } | null;
    if (!body?.spaceUri) {
      return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    }
    const space = await authority.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid === sa.issuer) {
      return c.json(
        { error: "InvalidRequest", reason: "owner-cannot-leave", message: "Owner cannot leave; delete the space instead" },
        400
      );
    }
    await authority.removeMember(body.spaceUri, sa.issuer);
    return c.json({ ok: true });
  });

  // Unified whoami — extension can override with richer data (e.g. community
  // accessLevel); without one, returns binary owner/member.
  app.get(`/xrpc/${SPACE_EXT}.whoami`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    if (!spaceUri) return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    const space = await authority.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const isOwner = space.ownerDid === sa.issuer;

    if (whoamiExtension) {
      const ext = await whoamiExtension({
        spaceUri,
        callerDid: sa.issuer,
        isOwner,
        ownerDid: space.ownerDid,
      });
      if (ext) return c.json(ext);
    }

    if (isOwner) return c.json({ isOwner: true, isMember: true });
    const member = await authority.getMember(spaceUri, sa.issuer);
    return c.json({ isOwner: false, isMember: !!member });
  });

  // ---- Credential endpoints ----

  app.post(`/xrpc/${SPACE}.getCredential`, auth, async (c) => {
    if (!authorityConfig.signing) {
      return c.json(
        { error: "NotImplemented", message: "authority is not configured to sign credentials" },
        501
      );
    }
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as { spaceUri?: string } | null;
    if (!body?.spaceUri) {
      return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    }
    const space = await authority.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const isOwner = space.ownerDid === sa.issuer;
    const member = isOwner ? null : await authority.getMember(body.spaceUri, sa.issuer);
    if (!isOwner && !member) {
      return c.json({ error: "Forbidden", reason: "not-member" }, 403);
    }

    if (space.appPolicy) {
      const allowed = checkClientId(space.appPolicy, sa.clientId);
      if (!allowed) return c.json({ error: "Forbidden", reason: "app-not-allowed" }, 403);
    }

    const ttl = authorityConfig.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS;
    const { credential, expiresAt } = await issueCredential(
      {
        iss: authorityConfig.serviceDid,
        sub: sa.issuer,
        space: body.spaceUri,
        scope: "rw",
        ttlMs: ttl,
      },
      authorityConfig.signing
    );
    return c.json({ credential, expiresAt });
  });

  app.post(`/xrpc/${SPACE}.refreshCredential`, async (c) => {
    if (!authorityConfig.signing) {
      return c.json(
        { error: "NotImplemented", message: "authority is not configured to sign credentials" },
        501
      );
    }
    const body = (await c.req.json().catch(() => null)) as { credential?: string } | null;
    if (!body?.credential) {
      return c.json({ error: "InvalidRequest", message: "credential required" }, 400);
    }
    const signing = authorityConfig.signing;
    const claims = await verifyAndAuthorizeRefresh(body.credential, authorityConfig);
    if ("error" in claims) return c.json(claims, claims.status);

    const space = await authority.getSpace(claims.space);
    if (!space) return c.json({ error: "NotFound" }, 404);
    const isOwner = space.ownerDid === claims.sub;
    const member = isOwner ? null : await authority.getMember(claims.space, claims.sub);
    if (!isOwner && !member) {
      return c.json({ error: "Forbidden", reason: "not-member" }, 403);
    }

    const ttl = authorityConfig.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS;
    const { credential, expiresAt } = await issueCredential(
      {
        iss: authorityConfig.serviceDid,
        sub: claims.sub,
        space: claims.space,
        scope: claims.scope,
        ttlMs: ttl,
      },
      signing
    );
    return c.json({ credential, expiresAt });
  });

  // ---- Membership manifest ----
  //
  // Issues a signed list of every space the caller is a member of (or owns)
  // according to this authority. Appviews carry it on inbound requests so
  // unioned listRecords queries can be filtered without syncing the full
  // member list. Same key material as credentials, different payload.

  app.post(`/xrpc/${SPACE}.getMembershipManifest`, auth, async (c) => {
    if (!authorityConfig.signing) {
      return c.json(
        { error: "NotImplemented", message: "authority is not configured to sign manifests" },
        501
      );
    }
    const sa = getAuth(c);
    const cap = authorityConfig.manifestMaxSpaces ?? 500;

    // Page through listSpaces — owner-or-member union — up to the cap.
    const seen = new Set<string>();
    const drain = async (scope: "owner" | "member"): Promise<void> => {
      let cursor: string | undefined;
      while (seen.size < cap) {
        const result = await authority.listSpaces({
          ...(scope === "owner" ? { ownerDid: sa.issuer } : { memberDid: sa.issuer }),
          cursor,
          limit: Math.min(200, cap - seen.size),
        });
        for (const s of result.spaces) {
          if (s.deletedAt == null) seen.add(s.uri);
          if (seen.size >= cap) break;
        }
        if (!result.cursor || seen.size >= cap) break;
        cursor = result.cursor;
      }
    };
    await drain("owner");
    if (seen.size < cap) await drain("member");

    const ttl = authorityConfig.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS;
    const { manifest, expiresAt } = await issueMembershipManifest(
      {
        iss: authorityConfig.serviceDid,
        sub: sa.issuer,
        spaces: [...seen],
        ttlMs: ttl,
      },
      authorityConfig.signing
    );
    return c.json({ manifest, expiresAt, truncated: seen.size >= cap });
  });
}

/** Verify a credential presented at refreshCredential. */
async function verifyAndAuthorizeRefresh(
  credential: string,
  authorityConfig: AuthorityConfig
): Promise<CredentialClaims | { error: string; reason?: string; message?: string; status: 400 | 401 }> {
  const peek = decodeUnverifiedClaims(credential);
  if (!peek) return { error: "InvalidRequest", reason: "malformed", status: 400 };
  if (peek.iss !== authorityConfig.serviceDid) {
    return { error: "Forbidden", reason: "wrong-issuer", status: 401 };
  }
  if (!authorityConfig.signing) {
    return { error: "InvalidState", status: 401 };
  }
  const signing = authorityConfig.signing;
  const result = await verifyCredential(credential, {
    expectedSpace: peek.space,
    resolveKey: async (iss) => (iss === authorityConfig.serviceDid ? signing.publicKey : null),
  });
  if (!result.ok) {
    return { error: "InvalidCredential", reason: result.reason, status: 401 };
  }
  return result.claims;
}

function checkClientId(
  appPolicy: NonNullable<SpaceRow["appPolicy"]>,
  clientId: string | undefined
): boolean {
  const listed = clientId ? appPolicy.apps.includes(clientId) : false;
  if (appPolicy.mode === "allow") return !listed;
  return listed;
}

/** Authorize a read request on the authority side — three valid paths:
 *  credential (set by upstream middleware), invite token, or service-auth JWT. */
async function authorizeRead(
  c: Context,
  authority: SpaceAuthority,
  spaceUri: string
): Promise<
  | { via: "credential"; claims: CredentialClaims }
  | { via: "token" }
  | { via: "jwt"; sa: ServiceAuth }
  | Response
> {
  const cred = c.get("spaceCredential") as CredentialClaims | undefined;
  if (cred) {
    if (cred.space !== spaceUri) {
      return c.json({ error: "Forbidden", reason: "credential-wrong-space" }, 403);
    }
    return { via: "credential", claims: cred };
  }
  const rawToken = extractInviteToken(c.req.raw);
  if (rawToken) {
    const ok = await checkInviteReadGrant(authority, rawToken, spaceUri, hashInviteToken);
    if (!ok) return c.json({ error: "Forbidden", reason: "invalid-invite-token" }, 403);
    return { via: "token" };
  }
  const sa = c.get("serviceAuth") as ServiceAuth | undefined;
  if (sa) return { via: "jwt", sa };
  return c.json(
    { error: "AuthRequired", message: "JWT, credential, or read-grant invite token required" },
    401
  );
}

function getAuth(c: Context): ServiceAuth {
  const auth = c.get("serviceAuth") as ServiceAuth | undefined;
  if (!auth) throw new Error("service auth not set");
  return auth;
}

function publicSpaceView(space: SpaceRow, forOwner: boolean) {
  return {
    uri: space.uri,
    ownerDid: space.ownerDid,
    type: space.type,
    key: space.key,
    serviceDid: space.serviceDid,
    appPolicyRef: space.appPolicyRef,
    createdAt: space.createdAt,
    ...(forOwner ? { appPolicy: space.appPolicy } : {}),
  };
}
