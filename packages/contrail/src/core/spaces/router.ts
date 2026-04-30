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
} from "./auth";
import { nextTid } from "./tid";
import { hashInviteToken } from "../invite/token";
import { buildSpaceUri } from "./uri";
import {
  DEFAULT_BLOB_MAX_SIZE,
  type AuthorityConfig,
  type RecordHostConfig,
  type RecordHost,
  type SpaceAuthority,
  type SpaceRow,
  type StorageAdapter,
} from "./types";
import { blobKey } from "./blob-adapter";
import { collectBlobCids } from "./blob-refs";
import { create as createCid, toString as cidToString } from "@atcute/cid";

/** Optional hook to extend `<ns>.spaceExt.whoami` with extra fields when a
 *  module above spaces (e.g. community) wants to override the default
 *  binary-membership response. If the hook returns a non-null object, that
 *  object is the entire response body. If null, falls through to the
 *  default behavior (just `isOwner`/`isMember`).
 *
 *  Spaces stays community-agnostic: any consumer can plug in here. */
export type WhoamiExtension = (input: {
  spaceUri: string;
  callerDid: string;
  isOwner: boolean;
  ownerDid: string;
}) => Promise<Record<string, unknown> | null>;

export interface SpacesRoutesOptions {
  /** Provide a custom middleware (e.g. for tests). If omitted and authority is set, a real one is built. */
  authMiddleware?: MiddlewareHandler;
  /** Storage adapter override. Defaults to HostedAdapter(db). */
  adapter?: StorageAdapter;
  /** Optional whoami extension; see {@link WhoamiExtension}. */
  whoamiExtension?: WhoamiExtension;
}

/** Umbrella registration: wires both the authority and the record-host
 *  routes against the same adapter. Today's deployments enable both via
 *  `config.spaces.authority` and `config.spaces.recordHost`. Either may be
 *  omitted in future split deployments — phase 5 lifts the assumption that
 *  one process runs both. */
export function registerSpacesRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig,
  options: SpacesRoutesOptions = {},
  ctx?: { adapter: StorageAdapter; verifier: import("@atcute/xrpc-server/auth").ServiceJwtVerifier } | null
): void {
  const spacesConfig = config.spaces;
  if (!spacesConfig) return;
  const authorityConfig = spacesConfig.authority;
  if (!authorityConfig) return;

  const adapter = options.adapter ?? ctx?.adapter ?? new HostedAdapter(db, config);
  const verifier = ctx?.verifier ?? buildVerifier(authorityConfig);
  const auth = options.authMiddleware ?? createServiceAuthMiddleware(verifier);

  registerAuthorityRoutes(app, adapter, authorityConfig, config, auth, options.whoamiExtension);

  if (spacesConfig.recordHost) {
    registerRecordHostRoutes(app, adapter, adapter, spacesConfig.recordHost, config, auth);
  }
}

/** Register the **space authority** XRPC surface — space lifecycle, member
 *  list, app policy, whoami. Does NOT touch records or blobs. */
export function registerAuthorityRoutes(
  app: Hono,
  authority: SpaceAuthority,
  authorityConfig: AuthorityConfig,
  config: ContrailConfig,
  auth: MiddlewareHandler,
  whoamiExtension?: WhoamiExtension
): void {
  /** Space endpoints are emitted per-deployment under the configured namespace;
   *  the deployment owns and publishes its own lexicons. The library ships
   *  templates at `lexicon-templates/spaces/*` that the generator instantiates
   *  under `<ns>.space.*` (spec-aligned) and `<ns>.spaceExt.*` (contrail
   *  extras — invites, whoami — that the permissioned-data spec doesn't cover). */
  const SPACE = `${config.namespace}.space`;
  const SPACE_EXT = `${config.namespace}.spaceExt`;

  // ---- Read endpoints ----

  app.get(`/xrpc/${SPACE}.listSpaces`, auth, async (c) => {
    const sa = getAuth(c);
    const scope = c.req.query("scope") ?? "member"; // "member" | "owner"
    const type = c.req.query("type") ?? undefined;
    const owner = c.req.query("owner") ?? undefined;
    const cursor = c.req.query("cursor") ?? undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

    const opts: Parameters<typeof authority.listSpaces>[0] = { type, cursor, limit };
    if (scope === "owner") opts.ownerDid = sa.issuer;
    else {
      opts.memberDid = sa.issuer;
      if (owner) opts.ownerDid = owner; // narrow to spaces owned by this DID
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
      // Anonymous read-token bearer — show non-owner space view.
      return c.json({ space: publicSpaceView(space, false) });
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
    // Owner is implicit; we still write a row so membership queries are uniform.
    await authority.addMember(uri, sa.issuer, sa.issuer);

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

  // Unified whoami — `<ns>.spaceExt.whoami?spaceUri=X` → { isOwner, isMember,
  // ... }. Extra fields (e.g. accessLevel for community-owned spaces) come
  // from the optional whoamiExtension hook; without one, response is binary.
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

    // Default: binary membership.
    if (isOwner) return c.json({ isOwner: true, isMember: true });
    const member = await authority.getMember(spaceUri, sa.issuer);
    return c.json({ isOwner: false, isMember: !!member });
  });
}

/** Register the **record host** XRPC surface — record + blob CRUD. Today
 *  consults the authority for membership / app-policy checks at write time;
 *  phase 3 adds a credential verifier that replaces those calls in
 *  split-deployment configurations. */
export function registerRecordHostRoutes(
  app: Hono,
  recordHost: RecordHost,
  authority: SpaceAuthority,
  recordHostConfig: RecordHostConfig,
  config: ContrailConfig,
  auth: MiddlewareHandler
): void {
  const SPACE = `${config.namespace}.space`;

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

  app.get(`/xrpc/${SPACE}.listRecords`, readAuth, async (c) => {
    const spaceUri = c.req.query("spaceUri");
    const collection = c.req.query("collection");
    if (!spaceUri || !collection) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and collection required" }, 400);
    }
    const space = await authority.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const authz = await authorizeRead(c, authority, spaceUri);
    if (authz instanceof Response) return authz;

    if (authz.via === "jwt") {
      const sa = authz.sa;
      const member = await authority.getMember(spaceUri, sa.issuer);
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

    const list = await recordHost.listRecords(spaceUri, collection, {
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
    const space = await authority.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const authz = await authorizeRead(c, authority, spaceUri);
    if (authz instanceof Response) return authz;

    if (authz.via === "jwt") {
      const sa = authz.sa;
      const member = await authority.getMember(spaceUri, sa.issuer);
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

    const record = await recordHost.getRecord(spaceUri, collection, author, rkey);
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
    const space = await authority.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const member = await authority.getMember(body.spaceUri, sa.issuer);
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
    if (recordHostConfig.blobs) {
      const cids = collectBlobCids(body.record);
      for (const cid of cids) {
        const meta = await recordHost.getBlobMeta(body.spaceUri, cid);
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
    await recordHost.putRecord({
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
    const space = await authority.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const member = await authority.getMember(body.spaceUri, sa.issuer);
    const result = checkAccess({
      op: "delete",
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
      targetAuthorDid: sa.issuer,
    });
    if (!result.allow) return c.json({ error: "Forbidden", reason: result.reason }, 403);

    await recordHost.deleteRecord(body.spaceUri, body.collection, sa.issuer, body.rkey);
    return c.json({ ok: true });
  });

  // Blobs (only registered when a blob adapter is configured)
  if (recordHostConfig.blobs) {
    const blobsCfg = recordHostConfig.blobs;
    const blobAdapter = blobsCfg.adapter;
    const maxSize = blobsCfg.maxSize ?? DEFAULT_BLOB_MAX_SIZE;
    const accept = blobsCfg.accept;

    app.post(`/xrpc/${SPACE}.uploadBlob`, auth, async (c) => {
      const sa = getAuth(c);
      const spaceUri = c.req.query("spaceUri");
      if (!spaceUri) {
        return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
      }
      const space = await authority.getSpace(spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);

      const member = await authority.getMember(spaceUri, sa.issuer);
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
      await recordHost.putBlobMeta({
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
      const space = await authority.getSpace(spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);

      const authz = await authorizeRead(c, authority, spaceUri);
      if (authz instanceof Response) return authz;

      if (authz.via === "jwt") {
        const sa = authz.sa;
        const member = await authority.getMember(spaceUri, sa.issuer);
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

      const meta = await recordHost.getBlobMeta(spaceUri, cid);
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
      const space = await authority.getSpace(spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);

      const member = await authority.getMember(spaceUri, sa.issuer);
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

      const result = await recordHost.listBlobMeta(spaceUri, {
        byUser: c.req.query("byUser") ?? undefined,
        cursor: c.req.query("cursor") ?? undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      });
      return c.json(result);
    });
  }
}

/** Authorize a read request: either a valid service-auth JWT (which also
 *  identifies the caller for member checks downstream) or a valid read-grant
 *  invite token bearer. */
async function authorizeRead(
  c: Context,
  authority: SpaceAuthority,
  spaceUri: string
): Promise<{ via: "token" } | { via: "jwt"; sa: ServiceAuth } | Response> {
  const rawToken = extractInviteToken(c.req.raw);
  if (rawToken) {
    const ok = await checkInviteReadGrant(authority, rawToken, spaceUri, hashInviteToken);
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
