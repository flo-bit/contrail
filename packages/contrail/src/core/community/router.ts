import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContrailConfig, Database } from "../types";
import type { ServiceAuth } from "../spaces/auth";
import type { StorageAdapter as SpacesAdapter } from "../spaces/types";
import { buildSpaceUri } from "../spaces/uri";
import { HostedAdapter } from "../spaces/adapter";
import { CommunityAdapter } from "./adapter";
import { CredentialCipher } from "./credentials";
import {
  resolveIdentity,
  createPdsSession,
  decodeJwtExp,
  tryRefreshSession,
} from "./pds";
import {
  generateKeyPair,
  buildGenesisOp,
  signGenesisOp,
  computeDidPlc,
  submitGenesisOp,
  getLastOpCid,
} from "./plc";
import {
  pdsCreateAccount,
  pdsGetRecommendedDidCredentials,
  pdsActivateAccount,
} from "./pds";
import {
  ProvisionOrchestrator,
  type PdsClient,
  type PlcClient,
} from "./provision";
import { resolveEffectiveLevel, resolveReachableSpaces, wouldCycle } from "./acl";
import { reconcile } from "./reconcile";
import type { AccessLevel } from "./types";
import {
  ACCESS_LEVELS,
  rankOf,
  isAccessLevel,
  isReservedKey,
  RESERVED_KEYS,
} from "./types";
import type { ServiceJwtVerifier } from "@atcute/xrpc-server/auth";
export interface CommunityRoutesOptions {
  /** Override auth middleware for tests. */
  authMiddleware?: MiddlewareHandler;
  /** Storage adapter overrides (defaults: HostedAdapter on the given db). */
  communityAdapter?: CommunityAdapter;
  spacesAdapter?: SpacesAdapter;
}

export function registerCommunityRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig,
  options: CommunityRoutesOptions = {},
  ctx?: {
    spacesAdapter: SpacesAdapter;
    verifier: ServiceJwtVerifier;
  } | null
): void {
  const cfg = config.community;
  if (!cfg) return;
  if (!config.spaces) {
    throw new Error("community module requires spaces to be enabled in config");
  }

  const community =
    options.communityAdapter ?? new CommunityAdapter(db);
  const spaces =
    options.spacesAdapter ?? ctx?.spacesAdapter ?? new HostedAdapter(db, config);
  const cipher = new CredentialCipher(cfg.masterKey);

  const auth =
    options.authMiddleware ??
    (() => {
      throw new Error(
        "community routes require an authMiddleware. Pass options.authMiddleware or ensure spaces.authMiddleware is configured."
      );
    })();

  const NS = `${config.namespace}.community`;
  const spaceType = config.spaces.type;
  const spaceServiceDid = cfg.serviceDid ?? config.spaces.serviceDid;

  // ==========================================================================
  // Community lifecycle
  // ==========================================================================

  app.post(`/xrpc/${NS}.adopt`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { identifier?: string; appPassword?: string }
      | null;
    if (!body?.identifier || !body.appPassword) {
      return c.json(
        { error: "InvalidRequest", message: "identifier and appPassword required" },
        400
      );
    }

    // 1. Resolve identifier → DID + PDS endpoint.
    let resolved;
    try {
      resolved = await resolveIdentity(body.identifier, {
        resolver: cfg.resolver,
        fetch: cfg.fetch,
      });
    } catch (err: any) {
      return c.json(
        { error: "InvalidRequest", message: `could not resolve: ${err.message}` },
        400
      );
    }

    // 2. Verify the credentials by creating a session.
    try {
      await createPdsSession(
        resolved.pdsEndpoint,
        body.identifier,
        body.appPassword,
        { fetch: cfg.fetch }
      );
    } catch (err: any) {
      return c.json(
        { error: "Unauthorized", message: `credential check failed: ${err.message}` },
        401
      );
    }

    // 3. Check not already adopted.
    const existing = await community.getCommunity(resolved.did);
    if (existing) {
      return c.json({ error: "AlreadyExists", did: resolved.did }, 409);
    }

    // 4. Encrypt + store.
    const encrypted = await cipher.encrypt(body.appPassword);
    await community.createAdoptedCommunity({
      did: resolved.did,
      pdsEndpoint: resolved.pdsEndpoint,
      appPasswordEncrypted: encrypted,
      identifier: body.identifier,
      createdBy: sa.issuer,
    });

    // 5. Bootstrap reserved spaces with caller as owner.
    await bootstrapReservedSpaces({
      communityDid: resolved.did,
      creatorDid: sa.issuer,
      spaces,
      community,
      type: spaceType,
      serviceDid: spaceServiceDid,
    });

    return c.json({ communityDid: resolved.did });
  });

  app.post(`/xrpc/${NS}.mint`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { handle?: string; pdsEndpoint?: string }
      | null;

    // Generate three keypairs: signing (atproto verificationMethod),
    // contrail-held rotation, creator-held rotation (recovery).
    const signingKey = await generateKeyPair();
    const contrailRotation = await generateKeyPair();
    const creatorRotation = await generateKeyPair();

    // Build + sign genesis op using contrail's rotation key.
    const unsigned = buildGenesisOp({
      rotationKeys: [contrailRotation.publicDidKey, creatorRotation.publicDidKey],
      verificationMethodAtproto: signingKey.publicDidKey,
      alsoKnownAs: body?.handle ? [`at://${body.handle}`] : [],
      services: body?.pdsEndpoint
        ? {
            atproto_pds: {
              type: "AtprotoPersonalDataServer",
              endpoint: body.pdsEndpoint,
            },
          }
        : {},
    });
    const signed = await signGenesisOp(unsigned, contrailRotation.privateJwk);
    const did = await computeDidPlc(signed);

    // Submit to PLC directory.
    const plcDir = cfg.plcDirectory ?? "https://plc.directory";
    try {
      await submitGenesisOp(plcDir, did, signed, { fetch: cfg.fetch });
    } catch (err: any) {
      return c.json(
        { error: "UpstreamFailure", message: err.message },
        502
      );
    }

    // Encrypt stored keys (signing + contrail rotation). The creator's
    // rotation key is returned once and never stored.
    const signingEncrypted = await cipher.encrypt(JSON.stringify(signingKey.privateJwk));
    const contrailRotEncrypted = await cipher.encrypt(
      JSON.stringify(contrailRotation.privateJwk)
    );

    await community.createMintedCommunity({
      did,
      signingKeyEncrypted: signingEncrypted,
      rotationKeyEncrypted: contrailRotEncrypted,
      createdBy: sa.issuer,
    });

    await bootstrapReservedSpaces({
      communityDid: did,
      creatorDid: sa.issuer,
      spaces,
      community,
      type: spaceType,
      serviceDid: spaceServiceDid,
    });

    return c.json({
      communityDid: did,
      recoveryKey: creatorRotation.privateJwk,
    });
  });

  app.post(`/xrpc/${NS}.provision`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | {
          attemptId?: string;
          handle?: string;
          email?: string;
          password?: string;
          inviteCode?: string;
          pdsEndpoint?: string;
        }
      | null;
    if (!body?.handle || !body.email || !body.password || !body.pdsEndpoint) {
      return c.json(
        {
          error: "InvalidRequest",
          message: "handle, email, password, pdsEndpoint required",
        },
        400
      );
    }

    // TODO: production should resolve the target PDS's DID dynamically (via
    // com.atproto.server.describeServer on body.pdsEndpoint) so the
    // service-auth JWT's `aud` matches what the PDS publishes for itself.
    // Using cfg.serviceDid here is a stopgap that works against tests where
    // the PDS is mocked via cfg.fetch.
    const pdsDid = cfg.serviceDid ?? config.spaces!.serviceDid;
    const orchestrator = buildOrchestrator(cfg, community, cipher, pdsDid);

    const attemptId = body.attemptId ?? crypto.randomUUID();
    let result;
    try {
      result = await orchestrator.provision({
        attemptId,
        pdsEndpoint: body.pdsEndpoint,
        handle: body.handle,
        email: body.email,
        password: body.password,
        inviteCode: body.inviteCode,
      });
    } catch (err: any) {
      return c.json(
        { error: "ProvisioningFailed", message: err.message },
        502
      );
    }

    // Hand the already-encrypted password from the provision_attempts row to
    // the communities row, keeping a single source of truth for the credential.
    const attempt = await community.getProvisionAttempt(attemptId);
    if (!attempt?.encryptedPassword) {
      return c.json(
        {
          error: "ProvisioningFailed",
          message: "provision attempt missing encryptedPassword after activation",
        },
        502
      );
    }

    await community.createFromProvisioned({
      did: result.did,
      pdsEndpoint: body.pdsEndpoint,
      handle: body.handle,
      appPasswordEncrypted: attempt.encryptedPassword,
      createdBy: sa.issuer,
    });

    await bootstrapReservedSpaces({
      communityDid: result.did,
      creatorDid: sa.issuer,
      spaces,
      community,
      type: spaceType,
      serviceDid: spaceServiceDid,
    });

    return c.json({ communityDid: result.did, status: result.status });
  });

  app.post(`/xrpc/${NS}.delete`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { communityDid?: string }
      | null;
    if (!body?.communityDid) {
      return c.json({ error: "InvalidRequest", message: "communityDid required" }, 400);
    }
    const row = await community.getCommunity(body.communityDid);
    if (!row) return c.json({ error: "NotFound" }, 404);

    const adminUri = buildSpaceUri({
      ownerDid: body.communityDid,
      type: spaceType,
      key: "$admin",
    });
    const level = await resolveEffectiveLevel(community, adminUri, sa.issuer);
    if (level !== "owner") {
      return c.json({ error: "Forbidden", reason: "owner-required" }, 403);
    }

    await community.softDeleteCommunity(body.communityDid);
    return c.json({ ok: true });
  });

  app.get(`/xrpc/${NS}.list`, auth, async (c) => {
    const sa = getAuth(c);
    const actor = c.req.query("actor") ?? sa.issuer;
    // Walk the delegation graph so communities reached via group memberships
    // (not just direct DID grants) are included.
    const reachable = await resolveReachableSpaces(community, actor);
    const rows = await community.listCommunitiesOwningSpaces([...reachable]);
    return c.json({
      communities: rows.map((r) => ({
        did: r.did,
        mode: r.mode,
        identifier: r.identifier,
        createdAt: r.createdAt,
      })),
    });
  });

  // `whoami` lives under `<ns>.spaceExt.whoami` — unified across user-owned
  // and community-owned spaces, returns `{ isOwner, isMember, accessLevel? }`.

  // ==========================================================================
  // Space lifecycle
  // ==========================================================================

  app.post(`/xrpc/${NS}.space.create`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { communityDid?: string; key?: string }
      | null;
    if (!body?.communityDid) {
      return c.json({ error: "InvalidRequest", message: "communityDid required" }, 400);
    }

    const communityRow = await community.getCommunity(body.communityDid);
    if (!communityRow) return c.json({ error: "NotFound", reason: "community-not-found" }, 404);

    if (body.key && isReservedKey(body.key)) {
      return c.json(
        { error: "InvalidRequest", reason: "reserved-key", message: `reserved keys cannot be created manually` },
        400
      );
    }

    // Caller must have admin+ in $admin.
    const adminUri = buildSpaceUri({
      ownerDid: body.communityDid,
      type: spaceType,
      key: "$admin",
    });
    const level = await resolveEffectiveLevel(community, adminUri, sa.issuer);
    if (!level || rankOf(level) < rankOf("admin")) {
      return c.json({ error: "Forbidden", reason: "admin-required-in-admin" }, 403);
    }

    const key = body.key ?? generateKey();
    const uri = buildSpaceUri({ ownerDid: body.communityDid, type: spaceType, key });

    const existing = await spaces.getSpace(uri);
    if (existing) return c.json({ error: "AlreadyExists", uri }, 409);

    await spaces.createSpace({
      uri,
      ownerDid: body.communityDid,
      type: spaceType,
      key,
      serviceDid: spaceServiceDid,
      appPolicyRef: null,
      appPolicy: null,
    });

    // Creator becomes owner of the new space.
    await community.grant({
      spaceUri: uri,
      subjectDid: sa.issuer,
      accessLevel: "owner",
      grantedBy: sa.issuer,
    });
    await reconcile(community, spaces, uri, sa.issuer);

    return c.json({
      space: {
        uri,
        ownerDid: body.communityDid,
        type: spaceType,
        key,
        serviceDid: spaceServiceDid,
        createdAt: Date.now(),
      },
    });
  });

  app.post(`/xrpc/${NS}.space.delete`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as { spaceUri?: string } | null;
    if (!body?.spaceUri) {
      return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    }
    const space = await spaces.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const communityRow = await community.getCommunity(space.ownerDid);
    if (!communityRow) {
      return c.json({ error: "InvalidRequest", reason: "not-community-owned" }, 400);
    }

    // Block deletion of reserved spaces.
    if (isReservedKey(space.key)) {
      return c.json({ error: "Forbidden", reason: "reserved-space-cannot-be-deleted" }, 403);
    }

    // Caller must be owner of this space OR admin+ in $admin.
    const onSpace = await resolveEffectiveLevel(community, body.spaceUri, sa.issuer);
    const onAdmin = await resolveEffectiveLevel(
      community,
      buildSpaceUri({ ownerDid: space.ownerDid, type: spaceType, key: "$admin" }),
      sa.issuer
    );
    const allowed =
      onSpace === "owner" || (onAdmin != null && rankOf(onAdmin) >= rankOf("admin"));
    if (!allowed) {
      return c.json({ error: "Forbidden", reason: "owner-or-admin-required" }, 403);
    }

    // Before clearing this space's ACL rows, capture any spaces that delegate
    // to it so we can re-reconcile their materialized membership after the
    // delete — any DIDs that reached those parents only through this space
    // must be removed from their spaces_members.
    const delegatingParents = await community.listSpacesDelegatingTo(body.spaceUri);

    await spaces.deleteSpace(body.spaceUri);
    await community.deleteAllAccessForSpace(body.spaceUri);
    // Drop the materialized membership too.
    const members = await spaces.listMembers(body.spaceUri);
    if (members.length) {
      await spaces.applyMembershipDiff(
        body.spaceUri,
        [],
        members.map((m) => m.did),
        sa.issuer
      );
    }
    for (const parent of delegatingParents) {
      await reconcile(community, spaces, parent, sa.issuer);
    }
    return c.json({ ok: true });
  });

  // ==========================================================================
  // Membership
  // ==========================================================================

  app.post(`/xrpc/${NS}.space.grant`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | {
          spaceUri?: string;
          subject?: { did?: string; spaceUri?: string };
          accessLevel?: string;
        }
      | null;
    if (!body?.spaceUri || !body.subject || !body.accessLevel) {
      return c.json(
        { error: "InvalidRequest", message: "spaceUri, subject, accessLevel required" },
        400
      );
    }
    if (!isAccessLevel(body.accessLevel)) {
      return c.json(
        { error: "InvalidRequest", message: `invalid accessLevel; one of ${ACCESS_LEVELS.join(", ")}` },
        400
      );
    }
    const subjectDid = body.subject.did;
    const subjectSpaceUri = body.subject.spaceUri;
    if ((subjectDid ? 1 : 0) + (subjectSpaceUri ? 1 : 0) !== 1) {
      return c.json(
        { error: "InvalidRequest", message: "subject must have exactly one of did or spaceUri" },
        400
      );
    }

    const space = await spaces.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const communityRow = await community.getCommunity(space.ownerDid);
    if (!communityRow) {
      return c.json({ error: "InvalidRequest", reason: "not-community-owned" }, 400);
    }

    // Caller must have at least manager.
    const callerLevel = await resolveEffectiveLevel(community, body.spaceUri, sa.issuer);
    if (!callerLevel || rankOf(callerLevel) < rankOf("manager")) {
      return c.json({ error: "Forbidden", reason: "manager-required" }, 403);
    }
    // Cannot grant higher than own level.
    if (rankOf(body.accessLevel) > rankOf(callerLevel)) {
      return c.json({ error: "Forbidden", reason: "cannot-grant-higher-than-self" }, 403);
    }
    // grant() upserts; block downgrading a subject who already outranks the caller.
    const existingGrant = await community.getAccessRow(
      body.spaceUri,
      (subjectDid ?? subjectSpaceUri)!
    );
    if (existingGrant && rankOf(existingGrant.accessLevel) > rankOf(callerLevel)) {
      return c.json({ error: "Forbidden", reason: "cannot-modify-higher-than-self" }, 403);
    }

    // Cycle check when delegating to another space.
    if (subjectSpaceUri) {
      if (subjectSpaceUri === body.spaceUri) {
        return c.json({ error: "InvalidRequest", reason: "self-reference" }, 400);
      }
      if (await wouldCycle(community, body.spaceUri, subjectSpaceUri)) {
        return c.json({ error: "InvalidRequest", reason: "cycle-detected" }, 400);
      }
    }

    await community.grant({
      spaceUri: body.spaceUri,
      subjectDid,
      subjectSpaceUri,
      accessLevel: body.accessLevel,
      grantedBy: sa.issuer,
    });
    await reconcile(community, spaces, body.spaceUri, sa.issuer);

    return c.json({ ok: true });
  });

  app.post(`/xrpc/${NS}.space.revoke`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | {
          spaceUri?: string;
          subject?: { did?: string; spaceUri?: string };
        }
      | null;
    if (!body?.spaceUri || !body.subject) {
      return c.json(
        { error: "InvalidRequest", message: "spaceUri and subject required" },
        400
      );
    }
    const subjectDid = body.subject.did;
    const subjectSpaceUri = body.subject.spaceUri;
    if ((subjectDid ? 1 : 0) + (subjectSpaceUri ? 1 : 0) !== 1) {
      return c.json(
        { error: "InvalidRequest", message: "subject must have exactly one of did or spaceUri" },
        400
      );
    }

    const space = await spaces.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    // Caller must outrank the target's current level.
    const subject = subjectDid ?? subjectSpaceUri!;
    const existing = await community.getAccessRow(body.spaceUri, subject);
    if (!existing) {
      return c.json({ error: "NotFound", reason: "no-such-grant" }, 404);
    }
    const callerLevel = await resolveEffectiveLevel(community, body.spaceUri, sa.issuer);
    if (!callerLevel || rankOf(callerLevel) < rankOf("manager")) {
      return c.json({ error: "Forbidden", reason: "manager-required" }, 403);
    }
    if (rankOf(existing.accessLevel) > rankOf(callerLevel)) {
      return c.json({ error: "Forbidden", reason: "cannot-revoke-higher-than-self" }, 403);
    }

    // Refuse to remove the last owner — would leave the space (and, on $admin,
    // the whole community) unmanageable. Caller can hand off ownership first
    // by promoting a successor to `owner`, then revoking themselves.
    if (existing.accessLevel === "owner") {
      const rows = await community.listAccessRows(body.spaceUri);
      const ownerCount = rows.filter((r) => r.accessLevel === "owner").length;
      if (ownerCount <= 1) {
        return c.json({ error: "LastOwner", reason: "last-owner" }, 409);
      }
    }

    await community.revoke({ spaceUri: body.spaceUri, subjectDid, subjectSpaceUri });
    await reconcile(community, spaces, body.spaceUri, sa.issuer);

    return c.json({ ok: true });
  });

  app.get(`/xrpc/${NS}.space.listMembers`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    if (!spaceUri) {
      return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    }
    const flatten = c.req.query("flatten") === "true";
    const space = await spaces.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    // Caller must have at least member.
    const callerLevel = await resolveEffectiveLevel(community, spaceUri, sa.issuer);
    if (!callerLevel) {
      return c.json({ error: "Forbidden", reason: "not-member" }, 403);
    }

    if (flatten) {
      const members = await spaces.listMembers(spaceUri);
      return c.json({ members: members.map((m) => ({ did: m.did, addedAt: m.addedAt })) });
    }

    const rows = await community.listAccessRows(spaceUri);
    return c.json({
      rows: rows.map((r) => ({
        subject: r.subjectDid
          ? { did: r.subjectDid }
          : { spaceUri: r.subjectSpaceUri },
        accessLevel: r.accessLevel,
        grantedBy: r.grantedBy,
        grantedAt: r.grantedAt,
      })),
    });
  });

  app.post(`/xrpc/${NS}.space.setAccessLevel`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | {
          spaceUri?: string;
          subject?: { did?: string; spaceUri?: string };
          accessLevel?: string;
        }
      | null;
    if (!body?.spaceUri || !body.subject || !body.accessLevel) {
      return c.json(
        { error: "InvalidRequest", message: "spaceUri, subject, accessLevel required" },
        400
      );
    }
    if (!isAccessLevel(body.accessLevel)) {
      return c.json({ error: "InvalidRequest", message: "invalid accessLevel" }, 400);
    }
    const subjectDid = body.subject.did;
    const subjectSpaceUri = body.subject.spaceUri;
    if ((subjectDid ? 1 : 0) + (subjectSpaceUri ? 1 : 0) !== 1) {
      return c.json(
        { error: "InvalidRequest", message: "subject must have exactly one of did or spaceUri" },
        400
      );
    }

    const space = await spaces.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const subject = subjectDid ?? subjectSpaceUri!;
    const existing = await community.getAccessRow(body.spaceUri, subject);
    if (!existing) return c.json({ error: "NotFound", reason: "no-such-grant" }, 404);

    const callerLevel = await resolveEffectiveLevel(community, body.spaceUri, sa.issuer);
    if (!callerLevel || rankOf(callerLevel) < rankOf("manager")) {
      return c.json({ error: "Forbidden", reason: "manager-required" }, 403);
    }
    // Caller must outrank both the old level AND the new one.
    if (rankOf(existing.accessLevel) > rankOf(callerLevel)) {
      return c.json({ error: "Forbidden", reason: "cannot-modify-higher-than-self" }, 403);
    }
    if (rankOf(body.accessLevel) > rankOf(callerLevel)) {
      return c.json({ error: "Forbidden", reason: "cannot-grant-higher-than-self" }, 403);
    }
    // Refuse to demote the last owner — same reasoning as the revoke path.
    if (existing.accessLevel === "owner" && body.accessLevel !== "owner") {
      const rows = await community.listAccessRows(body.spaceUri);
      const ownerCount = rows.filter((r) => r.accessLevel === "owner").length;
      if (ownerCount <= 1) {
        return c.json({ error: "LastOwner", reason: "last-owner" }, 409);
      }
    }

    await community.grant({
      spaceUri: body.spaceUri,
      subjectDid,
      subjectSpaceUri,
      accessLevel: body.accessLevel,
      grantedBy: sa.issuer,
    });
    await reconcile(community, spaces, body.spaceUri, sa.issuer);
    return c.json({ ok: true });
  });

  app.post(`/xrpc/${NS}.space.resync`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as { spaceUri?: string } | null;
    if (!body?.spaceUri) {
      return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    }
    const space = await spaces.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const level = await resolveEffectiveLevel(community, body.spaceUri, sa.issuer);
    if (!level || rankOf(level) < rankOf("admin")) {
      return c.json({ error: "Forbidden", reason: "admin-required" }, 403);
    }

    await reconcile(community, spaces, body.spaceUri, sa.issuer);
    return c.json({ ok: true });
  });

  // ==========================================================================
  // Publishing — public records (via community PDS) and in-space records
  // (authored by the community DID)
  // ==========================================================================

  app.post(`/xrpc/${NS}.putRecord`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | {
          communityDid?: string;
          collection?: string;
          rkey?: string;
          record?: Record<string, unknown>;
          validate?: boolean;
        }
      | null;
    if (!body?.communityDid || !body.collection || !body.record) {
      return c.json(
        { error: "InvalidRequest", message: "communityDid, collection, record required" },
        400
      );
    }

    const row = await community.getCommunity(body.communityDid);
    if (!row) return c.json({ error: "NotFound" }, 404);

    if (row.mode === "mint") {
      return c.json(
        { error: "NotSupported", reason: "publishing-not-supported-for-minted-communities" },
        400
      );
    }
    // adopt + provision modes both share the credential-proxy publishing path:
    // both store {pds_endpoint, identifier, app_password_encrypted}. Falls through.

    // Caller must be member+ in $publishers.
    const publishersUri = buildSpaceUri({
      ownerDid: body.communityDid,
      type: spaceType,
      key: "$publishers",
    });
    const level = await resolveEffectiveLevel(community, publishersUri, sa.issuer);
    if (!level) {
      return c.json({ error: "Forbidden", reason: "not-in-publishers" }, 403);
    }

    // Decrypt the stored app password and create a session.
    const raw = await community.getRawCredentials(body.communityDid);
    if (!raw?.appPasswordEncrypted || !raw.pdsEndpoint || !raw.identifier) {
      return c.json(
        { error: "InvalidState", reason: "missing-credentials" },
        500
      );
    }
    let session;
    try {
      const appPassword = await cipher.decryptString(raw.appPasswordEncrypted);
      session = await ensureSession({
        community,
        did: body.communityDid,
        pdsEndpoint: raw.pdsEndpoint,
        identifier: raw.identifier,
        password: appPassword,
        fetch: cfg.fetch,
      });
    } catch (err: any) {
      return c.json(
        { error: "UpstreamFailure", reason: "session-creation-failed", message: err.message },
        502
      );
    }

    // Proxy createRecord.
    const f = cfg.fetch ?? fetch;
    const res = await f(
      `${raw.pdsEndpoint.replace(/\/$/, "")}/xrpc/com.atproto.repo.createRecord`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessJwt}`,
        },
        body: JSON.stringify({
          repo: body.communityDid,
          collection: body.collection,
          rkey: body.rkey,
          record: body.record,
          validate: body.validate,
        }),
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return c.json(
        { error: "UpstreamFailure", message: `createRecord failed (${res.status}): ${text}` },
        502
      );
    }
    const out = (await res.json()) as { uri?: string; cid?: string };
    return c.json({ uri: out.uri, cid: out.cid });
  });

  app.post(`/xrpc/${NS}.deleteRecord`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { communityDid?: string; collection?: string; rkey?: string }
      | null;
    if (!body?.communityDid || !body.collection || !body.rkey) {
      return c.json(
        { error: "InvalidRequest", message: "communityDid, collection, rkey required" },
        400
      );
    }
    const row = await community.getCommunity(body.communityDid);
    if (!row) return c.json({ error: "NotFound" }, 404);
    if (row.mode === "mint") {
      return c.json({ error: "NotSupported" }, 400);
    }
    // adopt + provision: same credential-proxy path; falls through.

    const publishersUri = buildSpaceUri({
      ownerDid: body.communityDid,
      type: spaceType,
      key: "$publishers",
    });
    const level = await resolveEffectiveLevel(community, publishersUri, sa.issuer);
    if (!level) {
      return c.json({ error: "Forbidden", reason: "not-in-publishers" }, 403);
    }

    const raw = await community.getRawCredentials(body.communityDid);
    if (!raw?.appPasswordEncrypted || !raw.pdsEndpoint || !raw.identifier) {
      return c.json({ error: "InvalidState" }, 500);
    }
    let session;
    try {
      const appPassword = await cipher.decryptString(raw.appPasswordEncrypted);
      session = await ensureSession({
        community,
        did: body.communityDid,
        pdsEndpoint: raw.pdsEndpoint,
        identifier: raw.identifier,
        password: appPassword,
        fetch: cfg.fetch,
      });
    } catch (err: any) {
      return c.json(
        { error: "UpstreamFailure", message: err.message },
        502
      );
    }

    const f = cfg.fetch ?? fetch;
    const res = await f(
      `${raw.pdsEndpoint.replace(/\/$/, "")}/xrpc/com.atproto.repo.deleteRecord`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessJwt}`,
        },
        body: JSON.stringify({
          repo: body.communityDid,
          collection: body.collection,
          rkey: body.rkey,
        }),
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return c.json(
        { error: "UpstreamFailure", message: `deleteRecord failed (${res.status}): ${text}` },
        502
      );
    }
    return c.json({ ok: true });
  });

  app.post(`/xrpc/${NS}.space.putRecord`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | {
          spaceUri?: string;
          collection?: string;
          rkey?: string;
          record?: Record<string, unknown>;
        }
      | null;
    if (!body?.spaceUri || !body.collection || !body.record) {
      return c.json(
        { error: "InvalidRequest", message: "spaceUri, collection, record required" },
        400
      );
    }

    const space = await spaces.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    const row = await community.getCommunity(space.ownerDid);
    if (!row) return c.json({ error: "InvalidRequest", reason: "not-community-owned" }, 400);

    const level = await resolveEffectiveLevel(community, body.spaceUri, sa.issuer);
    if (!level || rankOf(level) < rankOf("admin")) {
      return c.json({ error: "Forbidden", reason: "admin-required" }, 403);
    }

    const rkey = body.rkey ?? generateKey();
    const now = Date.now();
    await spaces.putRecord({
      spaceUri: body.spaceUri,
      collection: body.collection,
      authorDid: space.ownerDid, // community DID
      rkey,
      cid: null,
      record: body.record,
      createdAt: now,
    });
    return c.json({ rkey, authorDid: space.ownerDid, createdAt: now });
  });

  app.post(`/xrpc/${NS}.space.deleteRecord`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; collection?: string; rkey?: string }
      | null;
    if (!body?.spaceUri || !body.collection || !body.rkey) {
      return c.json(
        { error: "InvalidRequest", message: "spaceUri, collection, rkey required" },
        400
      );
    }
    const space = await spaces.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    const row = await community.getCommunity(space.ownerDid);
    if (!row) return c.json({ error: "InvalidRequest", reason: "not-community-owned" }, 400);

    const level = await resolveEffectiveLevel(community, body.spaceUri, sa.issuer);
    if (!level || rankOf(level) < rankOf("admin")) {
      return c.json({ error: "Forbidden", reason: "admin-required" }, 403);
    }

    await spaces.deleteRecord(body.spaceUri, body.collection, space.ownerDid, body.rkey);
    return c.json({ ok: true });
  });

  // ==========================================================================
  // Credential health + reauth
  // ==========================================================================

  app.get(`/xrpc/${NS}.getHealth`, auth, async (c) => {
    const sa = getAuth(c);
    const communityDid = c.req.query("communityDid");
    if (!communityDid) {
      return c.json({ error: "InvalidRequest", message: "communityDid required" }, 400);
    }
    const row = await community.getCommunity(communityDid);
    if (!row) return c.json({ error: "NotFound" }, 404);

    // Any member of $admin can ask.
    const adminUri = buildSpaceUri({
      ownerDid: communityDid,
      type: spaceType,
      key: "$admin",
    });
    const level = await resolveEffectiveLevel(community, adminUri, sa.issuer);
    if (!level) {
      return c.json({ error: "Forbidden", reason: "not-member-of-admin" }, 403);
    }

    if (row.mode === "mint") {
      // Minted communities: we hold the signing key directly; if decryption works, healthy.
      try {
        const raw = await community.getRawCredentials(communityDid);
        if (raw?.signingKeyEncrypted) await cipher.decrypt(raw.signingKeyEncrypted);
        return c.json({ status: "healthy" });
      } catch {
        return c.json({ status: "expired" });
      }
    }

    // Adopted + provisioned: both store an app password against an external PDS.
    // Health = we can still create a session with the stored credentials.
    const raw = await community.getRawCredentials(communityDid);
    if (!raw?.appPasswordEncrypted || !raw.pdsEndpoint || !raw.identifier) {
      return c.json({ status: "expired" });
    }
    try {
      const appPassword = await cipher.decryptString(raw.appPasswordEncrypted);
      await ensureSession({
        community,
        did: communityDid,
        pdsEndpoint: raw.pdsEndpoint,
        identifier: raw.identifier,
        password: appPassword,
        fetch: cfg.fetch,
      });
      return c.json({ status: "healthy" });
    } catch {
      return c.json({ status: "expired" });
    }
  });

  app.post(`/xrpc/${NS}.reauth`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { communityDid?: string; appPassword?: string }
      | null;
    if (!body?.communityDid || !body.appPassword) {
      return c.json(
        { error: "InvalidRequest", message: "communityDid and appPassword required" },
        400
      );
    }
    const row = await community.getCommunity(body.communityDid);
    if (!row) return c.json({ error: "NotFound" }, 404);
    if (row.mode !== "adopt") {
      return c.json({ error: "NotSupported", reason: "reauth-only-for-adopted" }, 400);
    }

    // Caller must have owner in $admin.
    const adminUri = buildSpaceUri({
      ownerDid: body.communityDid,
      type: spaceType,
      key: "$admin",
    });
    const level = await resolveEffectiveLevel(community, adminUri, sa.issuer);
    if (level !== "owner") {
      return c.json({ error: "Forbidden", reason: "owner-required" }, 403);
    }

    // Re-resolve in case the PDS moved, and verify the new password.
    const identifier = row.identifier ?? body.communityDid;
    let resolved;
    try {
      resolved = await resolveIdentity(identifier, {
        resolver: cfg.resolver,
        fetch: cfg.fetch,
      });
    } catch (err: any) {
      return c.json(
        { error: "InvalidRequest", message: `could not resolve: ${err.message}` },
        400
      );
    }
    try {
      await createPdsSession(resolved.pdsEndpoint, identifier, body.appPassword, {
        fetch: cfg.fetch,
      });
    } catch (err: any) {
      return c.json(
        { error: "Unauthorized", message: `credential check failed: ${err.message}` },
        401
      );
    }

    const encrypted = await cipher.encrypt(body.appPassword);
    await community.updateAdoptedCredentials({
      did: body.communityDid,
      pdsEndpoint: resolved.pdsEndpoint,
      appPasswordEncrypted: encrypted,
      identifier,
    });
    return c.json({ ok: true });
  });

  // Invites live under `<ns>.invite.*` — see src/core/invite/router.ts. The
  // unified surface dispatches on space ownership to choose between the
  // ladder-granting path here and the binary-membership path in spaces.
}

// ============================================================================
// Helpers
// ============================================================================

function getAuth(c: Context): ServiceAuth {
  const a = c.get("serviceAuth") as ServiceAuth | undefined;
  if (!a) throw new Error("service auth not set");
  return a;
}

/** TID-ish ASCII lowercase base32-like identifier; good enough for space keys
 *  alongside the reserved `$`-prefixed ones. Mirrors the approach in spaces/tid.ts. */
function generateKey(): string {
  const chars = "234567abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(13));
  let out = "";
  for (let i = 0; i < 13; i++) out += chars[bytes[i]! % 32];
  return out;
}

/** Build a ProvisionOrchestrator wired with real PDS/PLC clients backed by
 *  `cfg.fetch` (so tests can stub the network the same way they do for the
 *  mint/adopt routes). Mirrors the ad-hoc wrapper used in the live e2e test
 *  at apps/contrail-e2e/tests/provision.test.ts. */
function buildOrchestrator(
  cfg: import("./types").CommunityConfig,
  adapter: CommunityAdapter,
  cipher: CredentialCipher,
  pdsDid: string
): ProvisionOrchestrator {
  const plcDirectory = cfg.plcDirectory ?? "https://plc.directory";
  const fetchOpts = { fetch: cfg.fetch };

  const plc: PlcClient = {
    submit: (did, op) => submitGenesisOp(plcDirectory, did, op as any, fetchOpts),
    getLastOpCid: (did) => getLastOpCid(plcDirectory, did, fetchOpts),
  };

  const pds: PdsClient = {
    createAccount: ({ pdsUrl, serviceAuthJwt, body }) =>
      pdsCreateAccount(pdsUrl, serviceAuthJwt, body, fetchOpts),
    getRecommendedDidCredentials: ({ pdsUrl, accessJwt }) =>
      pdsGetRecommendedDidCredentials(pdsUrl, accessJwt, fetchOpts),
    activateAccount: ({ pdsUrl, accessJwt }) =>
      pdsActivateAccount(pdsUrl, accessJwt, fetchOpts),
  };

  return new ProvisionOrchestrator({ adapter, cipher, plc, pds, pdsDid });
}

async function bootstrapReservedSpaces(args: {
  communityDid: string;
  creatorDid: string;
  spaces: SpacesAdapter;
  community: CommunityAdapter;
  type: string;
  serviceDid: string;
}): Promise<void> {
  for (const key of RESERVED_KEYS) {
    const uri = buildSpaceUri({
      ownerDid: args.communityDid,
      type: args.type,
      key,
    });
    await args.spaces.createSpace({
      uri,
      ownerDid: args.communityDid,
      type: args.type,
      key,
      serviceDid: args.serviceDid,
      appPolicyRef: null,
      appPolicy: null,
    });
    await args.community.grant({
      spaceUri: uri,
      subjectDid: args.creatorDid,
      accessLevel: "owner",
      grantedBy: args.creatorDid,
    });
    // Materialize membership: creator is in the space.
    await args.spaces.applyMembershipDiff(uri, [args.creatorDid], [], args.creatorDid);
  }
}

/** Ensure a usable PDS session for the given community DID. Tries the cached
 *  session first (with a 30s skew); if expired, tries refresh; if refresh fails
 *  (or there's no cache), falls back to creating a fresh session with the
 *  stored app password. The result is always written back to the cache. */
async function ensureSession(args: {
  community: CommunityAdapter;
  did: string;
  pdsEndpoint: string;
  identifier: string;
  password: string;
  fetch?: typeof fetch;
}): Promise<{ accessJwt: string; refreshJwt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const cached = await args.community.getSession(args.did);
  if (cached && cached.accessExp > now + 30) {
    return { accessJwt: cached.accessJwt, refreshJwt: cached.refreshJwt };
  }
  if (cached) {
    const refreshed = await tryRefreshSession({
      pdsUrl: args.pdsEndpoint,
      refreshJwt: cached.refreshJwt,
      fetch: args.fetch,
    });
    if (refreshed) {
      await args.community.upsertSession(args.did, refreshed);
      return { accessJwt: refreshed.accessJwt, refreshJwt: refreshed.refreshJwt };
    }
  }
  const session = await createPdsSession(
    args.pdsEndpoint,
    args.identifier,
    args.password,
    { fetch: args.fetch }
  );
  await args.community.upsertSession(args.did, {
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
    accessExp: decodeJwtExp(session.accessJwt),
  });
  return { accessJwt: session.accessJwt, refreshJwt: session.refreshJwt };
}
