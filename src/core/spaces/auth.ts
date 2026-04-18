import type { Context, MiddlewareHandler } from "hono";
import { ServiceJwtVerifier } from "@atcute/xrpc-server/auth";
import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  type DidDocumentResolver,
} from "@atcute/identity-resolver";
import type { Did, Nsid } from "@atcute/lexicons";
import type { SpacesConfig } from "./types";

export { ServiceJwtVerifier };

/** Build a ServiceJwtVerifier from a SpacesConfig, using the configured
 *  resolver or a default PLC+Web composite. */
export function buildVerifier(spaces: SpacesConfig): ServiceJwtVerifier {
  const resolver =
    spaces.resolver ??
    new CompositeDidDocumentResolver({
      methods: {
        plc: new PlcDidDocumentResolver(),
        web: new WebDidDocumentResolver(),
      },
    });
  return new ServiceJwtVerifier({
    serviceDid: spaces.serviceDid as Did,
    resolver,
  });
}

export interface ServiceAuth {
  issuer: string;
  audience: string;
  lxm: string | undefined;
  /** OAuth client_id of the caller, if the JWT carries one. */
  clientId?: string;
}

export interface ServiceAuthOptions {
  serviceDid: Did;
  resolver: DidDocumentResolver;
}

/** Hono middleware that verifies the Authorization: Bearer <JWT> as an atproto
 *  service-auth token. On success, attaches the decoded claims to c.var.serviceAuth.
 *  Expected Nsid method is taken from the route pattern (last segment after /xrpc/). */
export function createServiceAuthMiddleware(
  verifier: ServiceJwtVerifier
): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return c.json({ error: "AuthRequired", message: "Missing bearer token" }, 401);
    }
    const token = header.slice(7).trim();
    const lxm = extractLxmFromPath(c);

    const result = await verifier.verify(token, { lxm });
    if (!result.ok) {
      return c.json({ error: "AuthRequired", message: String(result.error) }, 401);
    }

    c.set("serviceAuth", {
      issuer: result.value.issuer,
      audience: result.value.audience,
      lxm: result.value.lxm,
    } satisfies ServiceAuth);

    await next();
  };
}

function extractLxmFromPath(c: Context): Nsid | null {
  const path = new URL(c.req.url).pathname;
  const match = path.match(/\/xrpc\/([a-zA-Z0-9.-]+)/);
  return (match?.[1] as Nsid) ?? null;
}

/** Read the service auth claims set by the middleware. Throws if unset. */
export function requireServiceAuth(c: Context): ServiceAuth {
  const auth = c.get("serviceAuth") as ServiceAuth | undefined;
  if (!auth) throw new Error("service auth missing; middleware not attached");
  return auth;
}

/** Verify a request's Authorization: Bearer token out-of-band (e.g. from a
 *  route handler that doesn't always require auth). Returns the claims on
 *  success, or null if missing/invalid. */
export async function verifyServiceAuthRequest(
  verifier: ServiceJwtVerifier,
  request: Request,
  lxm?: Nsid | null
): Promise<ServiceAuth | null> {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  const result = await verifier.verify(token, { lxm: lxm ?? null });
  if (!result.ok) return null;
  return {
    issuer: result.value.issuer,
    audience: result.value.audience,
    lxm: result.value.lxm,
  };
}

/** Pull a read-grant invite token off the request — query string `?inviteToken=`
 *  or `Authorization: Bearer atmo-invite:<token>`. Returns the raw token (not
 *  hashed) or null. Routes hash + look up via the adapter. */
export function extractInviteToken(request: Request): string | null {
  const url = new URL(request.url);
  const q = url.searchParams.get("inviteToken");
  if (q) return q.trim();
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer atmo-invite:")) {
    return header.slice("Bearer atmo-invite:".length).trim();
  }
  return null;
}

/** Validate a read-grant invite token against a target spaceUri. Returns true
 *  if the token exists, scopes to this space, has a kind that grants read
 *  (`read` or `read-join`), and is not expired/revoked. */
export async function checkInviteReadGrant(
  adapter: { getInvite(tokenHash: string): Promise<{ spaceUri: string; kind: string; revokedAt: number | null; expiresAt: number | null } | null> },
  rawToken: string,
  spaceUri: string,
  hashFn: (token: string) => Promise<string>
): Promise<boolean> {
  const tokenHash = await hashFn(rawToken);
  const invite = await adapter.getInvite(tokenHash);
  if (!invite) return false;
  if (invite.spaceUri !== spaceUri) return false;
  if (invite.kind !== "read" && invite.kind !== "read-join") return false;
  if (invite.revokedAt != null) return false;
  if (invite.expiresAt != null && invite.expiresAt <= Date.now()) return false;
  return true;
}
