/** Binding resolution: given a space URI, which DID is authorized to sign
 *  credentials for it, and where do we find that DID's verification key?
 *
 *  Two layers of pluggable resolvers compose into a credential verifier:
 *
 *    BindingResolver  — `ats://<owner>/<type>/<key>` → authority DID
 *    KeyResolver      — (DID, kid) → JsonWebKey
 *
 *  The BindingResolver is what makes user-owned-DID-with-PDS-record work:
 *  given a space URI, we resolve the owner's PDS, fetch the declaration
 *  record, and read its `authority` field. For provisioned (no-PDS) DIDs we
 *  fall back to the owner DID's `#atproto_space_authority` service entry.
 *  And finally for the trivial case (HappyView-style "owner self-issues"),
 *  we return the owner DID itself.
 *
 *  See conversation history (phase 4 design) for the rationale on why these
 *  three sources, in this order. */

import type { DidDocumentResolver } from "@atcute/identity-resolver";
import type { Did } from "@atcute/lexicons";
import { parseSpaceUri } from "./uri";
import type { RecordHost } from "./types";

export interface BindingResolver {
  /** Resolve the DID authorized to sign credentials for this space. Returns
   *  null if no binding could be found via this resolver — the composite
   *  walks down its list looking for a non-null. */
  resolveAuthority(spaceUri: string): Promise<string | null>;
}

export interface KeyResolver {
  /** Resolve `did`'s verification key for credential signing. `kid` is the
   *  full header `kid` value (e.g. "did:web:x.com#atproto_space_authority"),
   *  used to disambiguate when a DID doc lists multiple methods. */
  resolveKey(did: string, kid: string | undefined): Promise<JsonWebKey | null>;
}

// ---------------------------------------------------------------------------
// Binding resolvers
// ---------------------------------------------------------------------------

/** Always returns the configured authority DID. Used in-process when the
 *  authority and record host run in one deployment — no need to walk DID
 *  docs or PDSes; we know what we are. */
export function createLocalBindingResolver(args: {
  authorityDid: string;
}): BindingResolver {
  const { authorityDid } = args;
  return {
    async resolveAuthority() {
      return authorityDid;
    },
  };
}

/** Reads the record host's local enrollment table. This is the *canonical*
 *  binding source on a record host: the host owner explicitly consented to a
 *  given authority for a given space (via the `recordHost.enroll` endpoint
 *  or auto-enrollment from the authority's createSpace). PDS-record /
 *  DID-doc resolvers are out-of-band discovery aids; the enrollment is what
 *  actually gates whether records get stored here. */
export function createEnrollmentBindingResolver(args: {
  recordHost: RecordHost;
}): BindingResolver {
  return {
    async resolveAuthority(spaceUri) {
      const e = await args.recordHost.getEnrollment(spaceUri);
      return e?.authorityDid ?? null;
    },
  };
}

/** Returns the space owner DID as the authority. This is the implicit
 *  fallback ("HappyView path") — when no PDS record and no DID-doc service
 *  entry declare an issuer, the owner is taken to be its own. Whether the
 *  resulting credential actually verifies depends on whether the owner's DID
 *  doc publishes a usable signing key. */
export function createOwnerSelfBindingResolver(): BindingResolver {
  return {
    async resolveAuthority(spaceUri) {
      const parts = parseSpaceUri(spaceUri);
      return parts ? parts.ownerDid : null;
    },
  };
}

/** Walks the resolver list in order, returns the first non-null. Use this
 *  to compose [pdsRecord, didDocService, ownerSelf] etc. */
export function createCompositeBindingResolver(
  resolvers: BindingResolver[]
): BindingResolver {
  return {
    async resolveAuthority(spaceUri) {
      for (const r of resolvers) {
        const did = await r.resolveAuthority(spaceUri);
        if (did) return did;
      }
      return null;
    },
  };
}

/** Reads a space-declaration record from the owner's PDS at
 *  `at://<owner>/<type>/<key>` and returns its `authority` field if present.
 *
 *  This is the user-owned-DID path: the user writes a record to their PDS
 *  authorizing some service as the space's authority, no DID-doc edits
 *  required. */
export function createPdsBindingResolver(args: {
  /** DID resolver, used to look up the owner's PDS endpoint. */
  resolver: DidDocumentResolver;
  /** Fetch impl. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
}): BindingResolver {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  const timeoutMs = args.timeoutMs ?? 5000;

  return {
    async resolveAuthority(spaceUri) {
      const parts = parseSpaceUri(spaceUri);
      if (!parts) return null;
      const pds = await pdsEndpointFor(args.resolver, parts.ownerDid);
      if (!pds) return null;

      const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
      url.searchParams.set("repo", parts.ownerDid);
      url.searchParams.set("collection", parts.type);
      url.searchParams.set("rkey", parts.key);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url.toString(), { signal: ctrl.signal });
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as
        | { value?: { authority?: unknown } }
        | null;
      const authority = body?.value?.authority;
      return typeof authority === "string" && authority.startsWith("did:") ? authority : null;
    },
  };
}

/** Reads `service[id="#atproto_space_authority"].serviceEndpoint` from the
 *  owner's DID doc. This is the no-PDS path — useful for provisioned space
 *  DIDs that exist as DID docs only.
 *
 *  Note the service endpoint here is a *DID*, not a URL. The DID names the
 *  authority; the key resolver's job is to then fetch its verification key.
 *  For DID docs that declare a URL endpoint, we treat the URL as a
 *  did:web hint — caller can normalize. */
export function createDidDocBindingResolver(args: {
  resolver: DidDocumentResolver;
  /** Service id to look up. Defaults to "#atproto_space_authority". */
  serviceId?: string;
}): BindingResolver {
  const serviceId = args.serviceId ?? "#atproto_space_authority";
  return {
    async resolveAuthority(spaceUri) {
      const parts = parseSpaceUri(spaceUri);
      if (!parts) return null;
      let doc;
      try {
        doc = await args.resolver.resolve(parts.ownerDid as Did);
      } catch {
        return null;
      }
      const entry = doc.service?.find((s: { id?: string }) => s.id === serviceId);
      if (!entry) return null;
      const endpoint = (entry as { serviceEndpoint?: unknown }).serviceEndpoint;
      if (typeof endpoint !== "string") return null;
      // Endpoint may be a DID (preferred) or a URL hint. Only DIDs are
      // verifiable downstream; URLs require the caller to map URL → DID.
      return endpoint.startsWith("did:") ? endpoint : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Key resolvers
// ---------------------------------------------------------------------------

/** Knows the local authority's public key directly. Returns null for any
 *  other DID — composite with a DID-doc resolver if you also accept
 *  external authorities. */
export function createLocalKeyResolver(args: {
  authorityDid: string;
  publicKey: JsonWebKey;
}): KeyResolver {
  return {
    async resolveKey(did) {
      return did === args.authorityDid ? args.publicKey : null;
    },
  };
}

/** Resolves a DID, finds the verification method matching `kid`, returns
 *  its `publicKeyJwk`. */
export function createDidDocKeyResolver(args: {
  resolver: DidDocumentResolver;
}): KeyResolver {
  return {
    async resolveKey(did, kid) {
      let doc;
      try {
        doc = await args.resolver.resolve(did as Did);
      } catch {
        return null;
      }
      const methods = (doc as { verificationMethod?: VerificationMethod[] }).verificationMethod;
      if (!methods) return null;
      // kid is "<did>#<methodId>" — we match against the method.id which DID
      // docs spell as "<did>#<methodId>" too.
      const method = kid
        ? methods.find((m) => m.id === kid)
        : methods[0];
      if (!method?.publicKeyJwk) return null;
      return method.publicKeyJwk as JsonWebKey;
    },
  };
}

/** Walks resolvers in order; returns the first non-null. */
export function createCompositeKeyResolver(
  resolvers: KeyResolver[]
): KeyResolver {
  return {
    async resolveKey(did, kid) {
      for (const r of resolvers) {
        const k = await r.resolveKey(did, kid);
        if (k) return k;
      }
      return null;
    },
  };
}

interface VerificationMethod {
  id: string;
  type?: string;
  controller?: string;
  publicKeyJwk?: unknown;
  publicKeyMultibase?: string;
}

// ---------------------------------------------------------------------------
// Internal: PDS endpoint lookup
// ---------------------------------------------------------------------------

async function pdsEndpointFor(
  resolver: DidDocumentResolver,
  did: string
): Promise<string | null> {
  let doc;
  try {
    doc = await resolver.resolve(did as Did);
  } catch {
    return null;
  }
  const entry = doc.service?.find(
    (s: { id?: string }) => s.id === "#atproto_pds"
  );
  if (!entry) return null;
  const endpoint = (entry as { serviceEndpoint?: unknown }).serviceEndpoint;
  return typeof endpoint === "string" ? endpoint : null;
}
