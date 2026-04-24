/** Helpers for interacting with a community's PDS account — resolving identity
 *  and creating sessions from stored app passwords. */

import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  type DidDocumentResolver,
} from "@atcute/identity-resolver";

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
