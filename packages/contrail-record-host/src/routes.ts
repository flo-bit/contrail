/** Record-host XRPC routes — record + blob CRUD plus enrollment.
 *
 *  Auth precedence on every route:
 *    1. `X-Space-Credential` header (if a verifier is wired and the credential
 *       is valid) — caller DID = credential `sub`, no clientId.
 *    2. Read-route invite token (`?inviteToken=` or `Bearer atmo-invite:...`).
 *    3. Service-auth JWT — caller DID = JWT issuer.
 *
 *  When a credential is presented, the record host trusts it: no member
 *  check, no app-policy check (those happen at issuance time on the
 *  authority side). Service-auth requests still consult the authority. */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type {
  ContrailConfig,
  CredentialClaims,
  CredentialScope,
  CredentialVerifier,
  RecordHost,
  RecordHostConfig,
  ServiceAuth,
  SpaceAuthority,
} from "@atmo-dev/contrail-base";
import {
  blobKey,
  checkAccess,
  checkInviteReadGrant,
  DEFAULT_BLOB_MAX_SIZE,
  extractInviteToken,
  extractSpaceCredential,
  hashInviteToken,
  nextTid,
  parseSpaceUri,
} from "@atmo-dev/contrail-base";
import { collectBlobCids } from "./blob-refs";
import { create as createCid, toString as cidToString } from "@atcute/cid";

export function registerRecordHostRoutes(
  app: Hono,
  recordHost: RecordHost,
  authority: SpaceAuthority,
  recordHostConfig: RecordHostConfig,
  config: ContrailConfig,
  auth: MiddlewareHandler,
  /** Optional credential verifier. When present, the record host accepts
   *  `X-Space-Credential` as an alternative to a service-auth JWT. */
  credentialVerifier?: CredentialVerifier
): void {
  const SPACE = `${config.namespace}.space`;

  /** Auth wrapper: tries credential first, then delegates to JWT auth. */
  const authWithCredential: MiddlewareHandler = async (c, next) => {
    const credToken = extractSpaceCredential(c.req.raw);
    if (credToken) {
      if (!credentialVerifier) {
        return c.json(
          { error: "AuthRequired", reason: "credential-verifier-not-configured" },
          401
        );
      }
      const result = await credentialVerifier.verify(credToken);
      if (!result.ok) {
        return c.json({ error: "AuthRequired", reason: result.reason }, 401);
      }
      c.set("spaceCredential", result.claims);
      await next();
      return;
    }
    return auth(c, next);
  };

  const readAuth: MiddlewareHandler = async (c, next) => {
    if (extractInviteToken(c.req.raw)) {
      await next();
      return;
    }
    return authWithCredential(c, next);
  };

  /** Hard gate on every record-host operation: the space must be enrolled. */
  async function requireEnrollment(
    c: Context,
    spaceUri: string
  ): Promise<{ authorityDid: string } | Response> {
    const enrollment = await recordHost.getEnrollment(spaceUri);
    if (!enrollment) {
      return c.json(
        { error: "NotFound", reason: "not-enrolled", message: "space is not enrolled on this record host" },
        404
      );
    }
    return enrollment;
  }

  // ---- Enrollment endpoint ----
  const RECORD_HOST = `${config.namespace}.recordHost`;

  app.post(`/xrpc/${RECORD_HOST}.enroll`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; authority?: string }
      | null;
    if (!body?.spaceUri || !body.authority) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and authority required" }, 400);
    }
    const parts = parseSpaceUri(body.spaceUri);
    if (!parts) {
      return c.json({ error: "InvalidRequest", reason: "malformed-uri" }, 400);
    }
    const callerIsOwner = sa.issuer === parts.ownerDid;
    const callerIsAuthority = sa.issuer === body.authority;
    if (!callerIsOwner && !callerIsAuthority) {
      return c.json(
        { error: "Forbidden", reason: "not-owner-or-authority" },
        403
      );
    }
    await recordHost.enroll({
      spaceUri: body.spaceUri,
      authorityDid: body.authority,
      enrolledAt: Date.now(),
      enrolledBy: sa.issuer,
    });
    return c.json({ ok: true });
  });

  app.get(`/xrpc/${SPACE}.listRecords`, readAuth, async (c) => {
    const spaceUri = c.req.query("spaceUri");
    const collection = c.req.query("collection");
    if (!spaceUri || !collection) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and collection required" }, 400);
    }
    const enrollment = await requireEnrollment(c, spaceUri);
    if (enrollment instanceof Response) return enrollment;

    const authz = await authorizeRead(c, authority, spaceUri);
    if (authz instanceof Response) return authz;

    if (authz.via === "jwt") {
      const sa = authz.sa;
      const space = await authority.getSpace(spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);
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
    const enrollment = await requireEnrollment(c, spaceUri);
    if (enrollment instanceof Response) return enrollment;

    const authz = await authorizeRead(c, authority, spaceUri);
    if (authz instanceof Response) return authz;

    if (authz.via === "jwt") {
      const sa = authz.sa;
      const space = await authority.getSpace(spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);
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

  app.post(`/xrpc/${SPACE}.putRecord`, authWithCredential, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; collection?: string; rkey?: string; record?: Record<string, unknown> }
      | null;
    if (!body?.spaceUri || !body.collection || !body.record) {
      return c.json({ error: "InvalidRequest", message: "spaceUri, collection, record required" }, 400);
    }
    const enrollment = await requireEnrollment(c, body.spaceUri);
    if (enrollment instanceof Response) return enrollment;

    const caller = resolveCaller(c, body.spaceUri, "rw");
    if (caller instanceof Response) return caller;

    if (!caller.viaCredential) {
      const space = await authority.getSpace(body.spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);
      const member = await authority.getMember(body.spaceUri, caller.callerDid);
      const result = checkAccess({
        op: "write",
        space,
        callerDid: caller.callerDid,
        member,
        clientId: caller.clientId,
      });
      if (!result.allow) return c.json({ error: "Forbidden", reason: result.reason }, 403);
    }

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
      authorDid: caller.callerDid,
      rkey,
      cid: null,
      record: body.record,
      createdAt: now,
    });
    return c.json({ rkey, authorDid: caller.callerDid, createdAt: now });
  });

  app.post(`/xrpc/${SPACE}.deleteRecord`, authWithCredential, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; collection?: string; rkey?: string }
      | null;
    if (!body?.spaceUri || !body.collection || !body.rkey) {
      return c.json({ error: "InvalidRequest", message: "spaceUri, collection, rkey required" }, 400);
    }
    const enrollment = await requireEnrollment(c, body.spaceUri);
    if (enrollment instanceof Response) return enrollment;

    const caller = resolveCaller(c, body.spaceUri, "rw");
    if (caller instanceof Response) return caller;

    if (!caller.viaCredential) {
      const space = await authority.getSpace(body.spaceUri);
      if (!space) return c.json({ error: "NotFound" }, 404);
      const member = await authority.getMember(body.spaceUri, caller.callerDid);
      const result = checkAccess({
        op: "delete",
        space,
        callerDid: caller.callerDid,
        member,
        clientId: caller.clientId,
        targetAuthorDid: caller.callerDid,
      });
      if (!result.allow) return c.json({ error: "Forbidden", reason: result.reason }, 403);
    }

    await recordHost.deleteRecord(body.spaceUri, body.collection, caller.callerDid, body.rkey);
    return c.json({ ok: true });
  });

  // Blobs (only registered when a blob adapter is configured)
  if (recordHostConfig.blobs) {
    const blobsCfg = recordHostConfig.blobs;
    const blobAdapter = blobsCfg.adapter;
    const maxSize = blobsCfg.maxSize ?? DEFAULT_BLOB_MAX_SIZE;
    const accept = blobsCfg.accept;

    app.post(`/xrpc/${SPACE}.uploadBlob`, authWithCredential, async (c) => {
      const spaceUri = c.req.query("spaceUri");
      if (!spaceUri) {
        return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
      }
      const enrollment = await requireEnrollment(c, spaceUri);
      if (enrollment instanceof Response) return enrollment;

      const caller = resolveCaller(c, spaceUri, "rw");
      if (caller instanceof Response) return caller;

      if (!caller.viaCredential) {
        const space = await authority.getSpace(spaceUri);
        if (!space) return c.json({ error: "NotFound" }, 404);
        const member = await authority.getMember(spaceUri, caller.callerDid);
        const aclResult = checkAccess({
          op: "write",
          space,
          callerDid: caller.callerDid,
          member,
          clientId: caller.clientId,
        });
        if (!aclResult.allow) {
          return c.json({ error: "Forbidden", reason: aclResult.reason }, 403);
        }
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
        authorDid: caller.callerDid,
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
      const enrollment = await requireEnrollment(c, spaceUri);
      if (enrollment instanceof Response) return enrollment;

      const authz = await authorizeRead(c, authority, spaceUri);
      if (authz instanceof Response) return authz;

      if (authz.via === "jwt") {
        const sa = authz.sa;
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
      }

      const meta = await recordHost.getBlobMeta(spaceUri, cid);
      if (!meta) return c.json({ error: "NotFound" }, 404);
      const key = await blobKey(spaceUri, cid);
      const bytes = await blobAdapter.get(key);
      if (!bytes) return c.json({ error: "NotFound" }, 404);

      return new Response(bytes as BodyInit, {
        headers: {
          "content-type": meta.mimeType,
          "content-length": String(meta.size),
        },
      });
    });

    app.get(`/xrpc/${SPACE}.listBlobs`, authWithCredential, async (c) => {
      const spaceUri = c.req.query("spaceUri");
      if (!spaceUri) {
        return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
      }
      const enrollment = await requireEnrollment(c, spaceUri);
      if (enrollment instanceof Response) return enrollment;

      const caller = resolveCaller(c, spaceUri, "read");
      if (caller instanceof Response) return caller;

      if (!caller.viaCredential) {
        const space = await authority.getSpace(spaceUri);
        if (!space) return c.json({ error: "NotFound" }, 404);
        const member = await authority.getMember(spaceUri, caller.callerDid);
        const aclResult = checkAccess({
          op: "read",
          space,
          callerDid: caller.callerDid,
          member,
          clientId: caller.clientId,
        });
        if (!aclResult.allow) {
          return c.json({ error: "Forbidden", reason: aclResult.reason }, 403);
        }
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

/** Authorize a read request — three valid paths: a verified space credential
 *  (set by the credential middleware), a read-grant invite token, or a
 *  service-auth JWT. */
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

function resolveCaller(
  c: Context,
  requestSpace: string,
  requiredScope: CredentialScope
): { callerDid: string; clientId: string | undefined; viaCredential: boolean } | Response {
  const cred = c.get("spaceCredential") as CredentialClaims | undefined;
  if (cred) {
    if (cred.space !== requestSpace) {
      return c.json({ error: "Forbidden", reason: "credential-wrong-space" }, 403);
    }
    if (requiredScope === "rw" && cred.scope !== "rw") {
      return c.json({ error: "Forbidden", reason: "credential-wrong-scope" }, 403);
    }
    return { callerDid: cred.sub, clientId: undefined, viaCredential: true };
  }
  const sa = c.get("serviceAuth") as ServiceAuth | undefined;
  if (!sa) return c.json({ error: "AuthRequired", reason: "no-auth" }, 401);
  return { callerDid: sa.issuer, clientId: sa.clientId, viaCredential: false };
}

function getAuth(c: Context): ServiceAuth {
  const auth = c.get("serviceAuth") as ServiceAuth | undefined;
  if (!auth) throw new Error("service auth not set");
  return auth;
}
