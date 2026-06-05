/** Helpers for interacting with a community's PDS account — resolving identity
 *  and creating sessions from stored app passwords. */

import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  type DidDocumentResolver,
} from "@atcute/identity-resolver";

/** Canonicalize a PDS endpoint URL so allowlist comparisons aren't bypassed by
 *  trailing slash, default port, scheme case, or IDN encoding differences.
 *  Returns the URL's `origin` — scheme + host + (non-default) port — which
 *  collapses every variant of a single PDS to one string. Throws if the input
 *  is not a parseable URL; callers in request paths should catch and respond
 *  with a 400. */
export function normalizePdsEndpoint(url: string): string {
  return new URL(url).origin;
}

export interface ResolvedIdentity {
  did: string;
  handle: string | null;
  pdsEndpoint: string;
}

export interface PdsSession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
}

function defaultResolver(): DidDocumentResolver {
  return new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver(),
      web: new WebDidDocumentResolver(),
    },
  }) as unknown as DidDocumentResolver;
}

/** Given a handle or DID, resolve to { did, pdsEndpoint } using the DID doc's
 *  `atproto_pds` service entry. */
export async function resolveIdentity(
  identifier: string,
  opts: { resolver?: DidDocumentResolver; fetch?: typeof fetch } = {}
): Promise<ResolvedIdentity> {
  const f = opts.fetch ?? fetch;
  let did = identifier;
  let handle: string | null = null;

  if (!identifier.startsWith("did:")) {
    // Handle → DID via /.well-known or _atproto DNS.
    did = await resolveHandleToDid(identifier, f);
    handle = identifier;
  }

  const resolver = opts.resolver ?? defaultResolver();
  const doc = await (resolver as any).resolve(did);
  if (!doc) throw new Error(`could not resolve DID document for ${did}`);

  const services: Array<{ id?: string; type?: string; serviceEndpoint?: string }> =
    (doc as any).service ?? [];
  const pds = services.find(
    (s) =>
      s.type === "AtprotoPersonalDataServer" ||
      s.id === "#atproto_pds" ||
      s.id?.endsWith("#atproto_pds")
  );
  if (!pds?.serviceEndpoint) {
    throw new Error(`DID document for ${did} has no atproto_pds service`);
  }

  return { did, handle, pdsEndpoint: pds.serviceEndpoint };
}

async function resolveHandleToDid(handle: string, f: typeof fetch): Promise<string> {
  // Try /.well-known/atproto-did first (cheaper, no DNS).
  try {
    const res = await f(`https://${handle}/.well-known/atproto-did`, {
      redirect: "follow",
    });
    if (res.ok) {
      const did = (await res.text()).trim();
      if (did.startsWith("did:")) return did;
    }
  } catch {
    /* fall through */
  }
  // Fallback: DNS TXT _atproto.<handle>. Not available in Workers without
  // a DNS-over-HTTPS provider; use Cloudflare's 1.1.1.1 as a default.
  try {
    const res = await f(
      `https://cloudflare-dns.com/dns-query?name=_atproto.${handle}&type=TXT`,
      { headers: { accept: "application/dns-json" } }
    );
    if (res.ok) {
      const body = (await res.json()) as {
        Answer?: Array<{ data?: string; type?: number }>;
      };
      for (const ans of body.Answer ?? []) {
        if (ans.type === 16 && ans.data) {
          const trimmed = ans.data.replace(/^"|"$/g, "");
          const m = /^did=(did:[^"\s]+)$/.exec(trimmed);
          if (m) return m[1]!;
        }
      }
    }
  } catch {
    /* fall through */
  }
  throw new Error(`could not resolve handle ${handle}`);
}

/** Decode the `exp` claim from a JWT's payload (in seconds since epoch). Used
 *  by the session cache to decide if a cached access token is still usable.
 *  Returns 0 if the claim is missing or the token is malformed — callers should
 *  treat 0 as "expired, refresh now". Avoids `Buffer` so it works in Workers. */
export function decodeJwtExp(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length < 2) return 0;
  const payload = parts[1]!;
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (padded.length % 4)) % 4);
  try {
    const json = atob(padded + padding);
    const claims = JSON.parse(json) as { exp?: number };
    return Number(claims.exp ?? 0);
  } catch {
    return 0;
  }
}

/** POST com.atproto.server.refreshSession with the refresh JWT in Authorization.
 *  Returns null on any non-200 — callers fall back to `createPdsSession`. */
export async function tryRefreshSession(input: {
  pdsUrl: string;
  refreshJwt: string;
  fetch?: typeof fetch;
}): Promise<{ accessJwt: string; refreshJwt: string; accessExp: number } | null> {
  const f = input.fetch ?? fetch;
  const url = `${input.pdsUrl.replace(/\/$/, "")}/xrpc/com.atproto.server.refreshSession`;
  const res = await f(url, {
    method: "POST",
    headers: { authorization: `Bearer ${input.refreshJwt}` },
  });
  if (res.status !== 200) return null;
  const body = (await res.json().catch(() => null)) as
    | { accessJwt?: string; refreshJwt?: string }
    | null;
  if (!body?.accessJwt || !body.refreshJwt) return null;
  return {
    accessJwt: body.accessJwt,
    refreshJwt: body.refreshJwt,
    accessExp: decodeJwtExp(body.accessJwt),
  };
}

/** Create an atproto session on the given PDS using identifier + app password.
 *  Returns the access/refresh JWTs and the session's DID. */
export async function createPdsSession(
  pdsEndpoint: string,
  identifier: string,
  appPassword: string,
  opts: { fetch?: typeof fetch } = {}
): Promise<PdsSession> {
  const f = opts.fetch ?? fetch;
  const url = `${pdsEndpoint.replace(/\/$/, "")}/xrpc/com.atproto.server.createSession`;
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password: appPassword }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createSession failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as {
    accessJwt?: string;
    refreshJwt?: string;
    did?: string;
  };
  if (!body.accessJwt || !body.refreshJwt || !body.did) {
    throw new Error("createSession response missing expected fields");
  }
  return {
    accessJwt: body.accessJwt,
    refreshJwt: body.refreshJwt,
    did: body.did,
  };
}

export interface PdsDescribeServerResult {
  did: string;
  /** Other fields (availableUserDomains, contact, links, inviteCodeRequired)
   *  are returned by the PDS but unused by Contrail's provisioning flow. */
  [key: string]: unknown;
}

/** Calls `com.atproto.server.describeServer` on the target PDS to discover
 *  the DID it publishes for itself. Used as `aud` in the service-auth JWT for
 *  `createAccount`; the PDS verifies the audience matches its own DID and
 *  rejects with `BadJwtAudience` otherwise. Resolving dynamically (instead of
 *  hardcoding to a config value) is what allows a single Contrail instance
 *  to mint communities on multiple PDSes. */
export async function pdsDescribeServer(
  pdsEndpoint: string,
  opts: { fetch?: typeof fetch } = {}
): Promise<PdsDescribeServerResult> {
  const f = opts.fetch ?? fetch;
  const url = `${pdsEndpoint.replace(/\/$/, "")}/xrpc/com.atproto.server.describeServer`;
  const res = await f(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`describeServer failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as PdsDescribeServerResult;
  if (!body?.did || typeof body.did !== "string") {
    throw new Error("describeServer response missing required `did` field");
  }
  return body;
}

export interface PdsCreateAccountBody {
  handle: string;
  did: string;
  email: string;
  password: string;
  inviteCode?: string;
}

export interface PdsCreateAccountResult {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

/** Calls `com.atproto.server.createAccount` on the target PDS using a
 *  service-auth JWT (signed by the iss DID's verificationMethod). The PDS
 *  verifies `requester === did` against the published DID-doc, validates the
 *  invite, and creates the account in deactivated state. */
export async function pdsCreateAccount(
  pdsEndpoint: string,
  serviceAuthJwt: string,
  body: PdsCreateAccountBody,
  opts: { fetch?: typeof fetch } = {}
): Promise<PdsCreateAccountResult> {
  const f = opts.fetch ?? fetch;
  const url = `${pdsEndpoint.replace(/\/$/, "")}/xrpc/com.atproto.server.createAccount`;
  const res = await f(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${serviceAuthJwt}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createAccount failed (${res.status}): ${text}`);
  }
  return (await res.json()) as PdsCreateAccountResult;
}

export interface RecommendedDidCredentials {
  rotationKeys: string[];
  verificationMethods: { atproto: string };
  alsoKnownAs: string[];
  services: Record<string, { type: string; endpoint: string }>;
}

/** Calls `com.atproto.identity.getRecommendedDidCredentials` on the target PDS
 *  using the session's accessJwt (returned by `pdsCreateAccount`, NOT a
 *  service-auth JWT). Returns the DID-doc fields the PDS would self-publish. */
export async function pdsGetRecommendedDidCredentials(
  pdsEndpoint: string,
  accessJwt: string,
  opts: { fetch?: typeof fetch } = {}
): Promise<RecommendedDidCredentials> {
  const f = opts.fetch ?? fetch;
  const url = `${pdsEndpoint.replace(/\/$/, "")}/xrpc/com.atproto.identity.getRecommendedDidCredentials`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${accessJwt}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`getRecommendedDidCredentials failed (${res.status}): ${text}`);
  }
  return (await res.json()) as RecommendedDidCredentials;
}

/** Calls `com.atproto.server.activateAccount` on the target PDS using the
 *  session's accessJwt (returned by `pdsCreateAccount`, NOT a service-auth
 *  JWT). Resolves on success; throws otherwise. */
export async function pdsActivateAccount(
  pdsEndpoint: string,
  accessJwt: string,
  opts: { fetch?: typeof fetch } = {}
): Promise<void> {
  const f = opts.fetch ?? fetch;
  const url = `${pdsEndpoint.replace(/\/$/, "")}/xrpc/com.atproto.server.activateAccount`;
  const res = await f(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessJwt}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`activateAccount failed (${res.status}): ${text}`);
  }
}

export interface PdsCreateAppPasswordResult {
  name: string;
  password: string;
  createdAt: string;
}

/** Calls `com.atproto.server.createAppPassword` on the target PDS using the
 *  session's accessJwt. Returns the freshly minted app password. We always
 *  send `privileged: false` so the credential can be revoked without
 *  affecting the root account. */
export async function pdsCreateAppPassword(
  pdsEndpoint: string,
  accessJwt: string,
  name: string,
  opts: { fetch?: typeof fetch } = {}
): Promise<PdsCreateAppPasswordResult> {
  const f = opts.fetch ?? fetch;
  const url = `${pdsEndpoint.replace(/\/$/, "")}/xrpc/com.atproto.server.createAppPassword`;
  const res = await f(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessJwt}`,
    },
    body: JSON.stringify({ name, privileged: false }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`createAppPassword failed (${res.status}): ${text}`);
  }
  return (await res.json()) as PdsCreateAppPasswordResult;
}
