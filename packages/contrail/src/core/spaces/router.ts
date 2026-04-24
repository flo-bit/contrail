import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContrailConfig, Database } from "../types";
import { HostedAdapter } from "./adapter";
import { checkAccess } from "./acl";
import type { ServiceAuth } from "./auth";
import {
  buildVerifier,
  checkInviteReadGrant,
  createServiceAuthMiddleware,
  extractInviteToken,
  verifyServiceAuthRequest,
} from "./auth";
import { nextTid } from "./tid";
import { hashInviteToken } from "../invite/token";
import { resolveEffectiveLevel } from "../community/acl";
import { buildSpaceUri } from "./uri";
import {
  DEFAULT_BLOB_MAX_SIZE,
  type SpaceRow,
  type SpacesConfig,
  type StorageAdapter,
} from "./types";
import { blobKey } from "./blob-adapter";
import { collectBlobCids } from "./blob-refs";
import { create as createCid, toString as cidToString } from "@atcute/cid";
import type { Did } from "@atcute/lexicons";

export interface SpacesRoutesOptions {
  /** Provide a custom middleware (e.g. for tests). If omitted and spaces.resolver is set, a real one is built. */
  authMiddleware?: MiddlewareHandler;
  /** Storage adapter override. Defaults to HostedAdapter(db). */
  adapter?: StorageAdapter;
}

export function registerSpacesRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig,
  options: SpacesRoutesOptions = {},
  ctx?: { adapter: StorageAdapter; verifier: import("@atcute/xrpc-server/auth").ServiceJwtVerifier } | null,
  community?: import("../community/adapter").CommunityAdapter | null
): void {
  const spacesConfig = config.spaces;
  if (!spacesConfig) return;

  const adapter = options.adapter ?? ctx?.adapter ?? new HostedAdapter(db, config);
  const verifier = ctx?.verifier ?? buildVerifier(spacesConfig);
  const auth = options.authMiddleware ?? createServiceAuthMiddleware(verifier);

  /** Read-route auth: skip the JWT middleware when an `?inviteToken=` is
   *  present so anonymous bearer reads don't 401 before the route handler can
   *  validate the token. The route handler is responsible for actually checking
   *  the token (via `authorizeRead`). */
  const readAuth: MiddlewareHandler = async (c, next) => {
    if (extractInviteToken(c.req.raw)) {
      await next();
      return;
    }
    return auth(c, next);
  };

  /** Authorize a read request: either a valid service-auth JWT (which also
   *  identifies the caller for member checks downstream) or a valid read-grant
   *  invite token bearer (`?inviteToken=...` or
   *  `Authorization: Bearer atmo-invite:<token>`). */
  async function authorizeRead(
    c: Context,
    spaceUri: string
  ): Promise<{ via: "token" } | { via: "jwt"; sa: ServiceAuth } | Response> {
    const rawToken = extractInviteToken(c.req.raw);
    if (rawToken) {
      const ok = await checkInviteReadGrant(adapter, rawToken, spaceUri, hashInviteToken);
      if (!ok) return c.json({ error: "Forbidden", reason: "invalid-invite-token" }, 403);
      return { via: "token" };
    }
    const sa = c.get("serviceAuth") as ServiceAuth | undefined;
    if (sa) return { via: "jwt", sa };
    return c.json(
      { error: "AuthRequired", message: "JWT or read-grant invite token required" },
      401
    );
  }

  /** Space endpoints are emitted per-deployment under the configured namespace;
   *  the deployment owns and publishes its own lexicons. The library ships
   *  templates at `lexicon-templates/spaces/*` that the generator instantiates
   *  under `<ns>.space.*` (spec-aligned) and `<ns>.spaceExt.*` (contrail
   *  extras — invites, whoami — that the permissioned-data spec doesn't cover). */
  const SPACE = `${config.namespace}.space`;
  const SPACE_EXT = `${config.namespace}.spaceExt`;

  // Read endpoints
  app.get(`/xrpc/${SPACE}.listSpaces`, auth, async (c) => {
    const sa = getAuth(c);
    const scope = c.req.query("scope") ?? "member"; // "member" | "owner"
    const type = c.req.query("type") ?? undefined;
    const owner = c.req.query("owner") ?? undefined;
    const cursor = c.req.query("cursor") ?? undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

    const opts: Parameters<typeof adapter.listSpaces>[0] = { type, cursor, limit };
    if (scope === "owner") opts.ownerDid = sa.issuer;
    else {
      opts.memberDid = sa.issuer;
      if (owner) opts.ownerDid = owner; // narrow to spaces owned by this DID
    }

    const result = await adapter.listSpaces(opts);
    return c.json({
      spaces: result.spaces.map((s) => publicSpaceView(s, s.ownerDid === sa.issuer)),
      cursor: result.cursor,
    });
  });

  app.get(`/xrpc/${SPACE}.listMembers`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    if (!spaceUri) return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    const space = await adapter.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const isOwner = space.ownerDid === sa.issuer;
    const member = isOwner ? null : await adapter.getMember(spaceUri, sa.issuer);
    if (!isOwner && !member) {
      return c.json({ error: "Forbidden", reason: "not-member" }, 403);
    }
    const members = await adapter.listMembers(spaceUri);
    return c.json({ members });
  });

  app.get(`/xrpc/${SPACE}.getSpace`, readAuth, async (c) => {
    const uri = c.req.query("uri");
    if (!uri) return c.json({ error: "InvalidRequest", message: "uri required" }, 400);
    const space = await adapter.getSpace(uri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const authz = await authorizeRead(c, uri);
    if (authz instanceof Response) return authz;

    if (authz.via === "token") {
      // Anonymous read-token bearer — show non-owner space view.
      return c.json({ space: publicSpaceView(space, false) });
    }

    const sa = authz.sa;
    const isOwner = sa.issuer === space.ownerDid;
    const member = isOwner ? null : await adapter.getMember(uri, sa.issuer);
    if (!isOwner && !member) {
      return c.json({ error: "Forbidden", reason: "not-member" }, 403);
    }
    return c.json({ space: publicSpaceView(space, isOwner) });
  });

  app.get(`/xrpc/${SPACE}.listRecords`, readAuth, async (c) => {
    const spaceUri = c.req.query("spaceUri");
    const collection = c.req.query("collection");
    if (!spaceUri || !collection) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and collection required" }, 400);
    }
    const space = await adapter.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const authz = await authorizeRead(c, spaceUri);
    if (authz instanceof Response) return authz;

    if (authz.via === "jwt") {
      const sa = authz.sa;
      const member = await adapter.getMember(spaceUri, sa.issuer);
      const result = checkAccess({
        op: "read",
        space,
        callerDid: sa.issuer,
        member,
        clientId: sa.clientId,
      });
      if (!result.allow) {
        return c.json({ error: "Forbidden", reason: result.reason }, 403);
      }
    }

    const list = await adapter.listRecords(spaceUri, collection, {
      byUser: c.req.query("byUser") ?? undefined,
      cursor: c.req.query("cursor") ?? undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    return c.json(list);
  });

  app.get(`/xrpc/${SPACE}.getRecord`, readAuth, async (c) => {
    const spaceUri = c.req.query("spaceUri");
    const collection = c.req.query("collection");
    const author = c.req.query("author");
    const rkey = c.req.query("rkey");
    if (!spaceUri || !collection || !author || !rkey) {
      return c.json({ error: "InvalidRequest", message: "spaceUri, collection, author, rkey required" }, 400);
    }
    const space = await adapter.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const authz = await authorizeRead(c, spaceUri);
    if (authz instanceof Response) return authz;

    if (authz.via === "jwt") {
      const sa = authz.sa;
      const member = await adapter.getMember(spaceUri, sa.issuer);
      const result = checkAccess({
        op: "read",
        space,
        callerDid: sa.issuer,
        member,
        clientId: sa.clientId,
        targetAuthorDid: author,
      });
      if (!result.allow) return c.json({ error: "Forbidden", reason: result.reason }, 403);
    }

    const record = await adapter.getRecord(spaceUri, collection, author, rkey);
    if (!record) return c.json({ error: "NotFound" }, 404);
    return c.json({ record });
  });

  // Write endpoints
  app.post(`/xrpc/${SPACE}.putRecord`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; collection?: string; rkey?: string; record?: Record<string, unknown> }
      | null;
    if (!body?.spaceUri || !body.collection || !body.record) {
      return c.json({ error: "InvalidRequest", message: "spaceUri, collection, record required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const member = await adapter.getMember(body.spaceUri, sa.issuer);
    const result = checkAccess({
      op: "write",
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
    });
    if (!result.allow) return c.json({ error: "Forbidden", reason: result.reason }, 403);

    // Validate that every blob referenced by this record has already been
    // uploaded into this space. This mirrors how PDSes require uploadBlob
    // before putRecord, and prevents forging refs to blobs the caller never
    // actually claimed.
    if (spacesConfig.blobs) {
      const cids = collectBlobCids(body.record);
      for (const cid of cids) {
        const meta = await adapter.getBlobMeta(body.spaceUri, cid);
        if (!meta) {
          return c.json(
            {
              error: "InvalidRequest",
              reason: "unknown-blob-ref",
              message: `Record references blob ${cid} that has not been uploaded to this space.`,
            },
            400
          );
        }
      }
    }

    const rkey = body.rkey ?? nextTid();
    const now = Date.now();
    await adapter.putRecord({
      spaceUri: body.spaceUri,
      collection: body.collection,
      authorDid: sa.issuer,
      rkey,
      cid: null,
      record: body.record,
      createdAt: now,
    });
    return c.json({ rkey, authorDid: sa.issuer, createdAt: now });
  });

  app.post(`/xrpc/${SPACE}.deleteRecord`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; collection?: string; rkey?: string }
      | null;
    if (!body?.spaceUri || !body.collection || !body.rkey) {
      return c.json({ error: "InvalidRequest", message: "spaceUri, collection, rkey required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const member = await adapter.getMember(body.spaceUri, sa.issuer);
    const result = checkAccess({
      op: "delete",
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
      targetAuthorDid: sa.issuer,
    });
    if (!result.allow) return c.json({ error: "Forbidden", reason: result.reason }, 403);

    await adapter.deleteRecord(body.spaceUri, body.collection, sa.issuer, body.rkey);
    return c.json({ ok: true });
  });

  // Blobs (only registered when a blob adapter is configured)
  if (spacesConfig.blobs) {
    const blobsCfg = spacesConfig.blobs;
    const blobAdapter = blobsCfg.adapter;
    const maxSize = blobsCfg.maxSize ?? DEFAULT_BLOB_MAX_SIZE;
    const accept = blobsCfg.accept;

    app.post(`/xrpc/${SPACE}.uploadBlob`, auth, async (c) => {
      const sa = getAuth(c);
      const spaceUri = c.req.query("spaceUri");
      if (!spaceUri) {
        return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
      }
      const space = await adapter.getSpace(spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);

      const member = await adapter.getMember(spaceUri, sa.issuer);
      const aclResult = checkAccess({
        op: "write",
        space,
        callerDid: sa.issuer,
        member,
        clientId: sa.clientId,
      });
      if (!aclResult.allow) {
        return c.json({ error: "Forbidden", reason: aclResult.reason }, 403);
      }

      const mimeType = c.req.header("content-type") ?? "application/octet-stream";
      if (accept && !accept.includes(mimeType)) {
        return c.json(
          { error: "InvalidMimeType", message: `MIME type ${mimeType} is not accepted.` },
          400
        );
      }

      const declaredLen = c.req.header("content-length");
      if (declaredLen && Number(declaredLen) > maxSize) {
        return c.json(
          { error: "BlobTooLarge", message: `Blob exceeds max size of ${maxSize} bytes.` },
          413
        );
      }

      const buf = await c.req.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.byteLength > maxSize) {
        return c.json(
          { error: "BlobTooLarge", message: `Blob exceeds max size of ${maxSize} bytes.` },
          413
        );
      }

      const cid = await createCid(0x55, bytes);
      const cidString = cidToString(cid);
      const key = await blobKey(spaceUri, cidString);

      await blobAdapter.put(key, bytes, { mimeType, size: bytes.byteLength });
      await adapter.putBlobMeta({
        spaceUri,
        cid: cidString,
        mimeType,
        size: bytes.byteLength,
        authorDid: sa.issuer,
        createdAt: Date.now(),
      });

      return c.json({
        blob: {
          $type: "blob",
          ref: { $link: cidString },
          mimeType,
          size: bytes.byteLength,
        },
      });
    });

    app.get(`/xrpc/${SPACE}.getBlob`, readAuth, async (c) => {
      const spaceUri = c.req.query("spaceUri");
      const cid = c.req.query("cid");
      if (!spaceUri || !cid) {
        return c.json({ error: "InvalidRequest", message: "spaceUri and cid required" }, 400);
      }
      const space = await adapter.getSpace(spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);

      const authz = await authorizeRead(c, spaceUri);
      if (authz instanceof Response) return authz;

      if (authz.via === "jwt") {
        const sa = authz.sa;
        const member = await adapter.getMember(spaceUri, sa.issuer);
        const aclResult = checkAccess({
          op: "read",
          space,
          callerDid: sa.issuer,
          member,
          clientId: sa.clientId,
        });
        if (!aclResult.allow) {
          return c.json({ error: "Forbidden", reason: aclResult.reason }, 403);
        }
      }

      const meta = await adapter.getBlobMeta(spaceUri, cid);
      if (!meta) return c.json({ error: "NotFound" }, 404);
      const key = await blobKey(spaceUri, cid);
      const bytes = await blobAdapter.get(key);
      if (!bytes) return c.json({ error: "NotFound" }, 404);

      return new Response(bytes, {
        headers: {
          "content-type": meta.mimeType,
          "content-length": String(meta.size),
        },
      });
    });

    app.get(`/xrpc/${SPACE}.listBlobs`, auth, async (c) => {
      const sa = getAuth(c);
      const spaceUri = c.req.query("spaceUri");
      if (!spaceUri) {
        return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
      }
      const space = await adapter.getSpace(spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);

      const member = await adapter.getMember(spaceUri, sa.issuer);
      const aclResult = checkAccess({
        op: "read",
        space,
        callerDid: sa.issuer,
        member,
        clientId: sa.clientId,
      });
      if (!aclResult.allow) {
        return c.json({ error: "Forbidden", reason: aclResult.reason }, 403);
      }

      const result = await adapter.listBlobMeta(spaceUri, {
        byUser: c.req.query("byUser") ?? undefined,
        cursor: c.req.query("cursor") ?? undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      });
      return c.json(result);
    });
  }

  // Space management (owner-gated)
  app.post(`/xrpc/${SPACE}.createSpace`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      type?: string;
      key?: string;
      appPolicy?: SpaceRow["appPolicy"];
      appPolicyRef?: string;
    };

    const type = body.type ?? spacesConfig.type;
    const key = body.key ?? nextTid();
    const uri = buildSpaceUri({ ownerDid: sa.issuer, type, key });

    const existing = await adapter.getSpace(uri);
    if (existing) return c.json({ error: "AlreadyExists", uri }, 409);

    const space = await adapter.createSpace({
      uri,
      ownerDid: sa.issuer,
      type,
      key,
      serviceDid: spacesConfig.serviceDid,
      appPolicyRef: body.appPolicyRef ?? null,
      appPolicy: body.appPolicy ?? spacesConfig.defaultAppPolicy ?? null,
    });
    // Owner is implicit; we still write a row so membership queries are uniform.
    await adapter.addMember(uri, sa.issuer, sa.issuer);

    return c.json({ space: publicSpaceView(space, true) });
  });

  // Invites live under `<ns>.invite.*` — see src/core/invite/router.ts. The
  // unified surface dispatches on space ownership.

  app.post(`/xrpc/${SPACE}.addMember`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; did?: string }
      | null;
    if (!body?.spaceUri || !body.did) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and did required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    await adapter.addMember(body.spaceUri, body.did, sa.issuer);
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
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    if (body.did === space.ownerDid) {
      return c.json({ error: "InvalidRequest", reason: "cannot-remove-owner" }, 400);
    }
    await adapter.removeMember(body.spaceUri, body.did);
    return c.json({ ok: true });
  });

  app.post(`/xrpc/${SPACE}.leaveSpace`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as { spaceUri?: string } | null;
    if (!body?.spaceUri) {
      return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid === sa.issuer) {
      return c.json(
        { error: "InvalidRequest", reason: "owner-cannot-leave", message: "Owner cannot leave; delete the space instead" },
        400
      );
    }
    await adapter.removeMember(body.spaceUri, sa.issuer);
    return c.json({ ok: true });
  });

  // Unified whoami — `<ns>.spaceExt.whoami?spaceUri=X` → { isOwner, isMember,
  // accessLevel? }. `accessLevel` is present only when the target space is
  // community-owned; for user-owned spaces membership is binary.
  app.get(`/xrpc/${SPACE_EXT}.whoami`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    if (!spaceUri) return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    const space = await adapter.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const isOwner = space.ownerDid === sa.issuer;

    // Community-owned space: resolve through the access-level ladder. The
    // reconciler keeps spaces_members in sync, so isMember derives from the
    // effective level directly.
    const isCommunity = community ? !!(await community.getCommunity(space.ownerDid)) : false;
    if (isCommunity) {
      const level = await resolveEffectiveLevel(community!, spaceUri, sa.issuer);
      return c.json({
        isOwner,
        isMember: isOwner || !!level,
        accessLevel: level,
      });
    }

    // User-owned space: binary membership.
    if (isOwner) return c.json({ isOwner: true, isMember: true });
    const member = await adapter.getMember(spaceUri, sa.issuer);
    return c.json({ isOwner: false, isMember: !!member });
  });
}

function buildAuthMiddleware(spaces: SpacesConfig): MiddlewareHandler {
  const verifier = buildVerifier(spaces);
  return createServiceAuthMiddleware(verifier);
}

function getAuth(c: Parameters<MiddlewareHandler>[0]): ServiceAuth {
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

