import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  type DidDocumentResolver,
} from "@atcute/identity-resolver";
import { type Did } from "@atcute/lexicons";
import { Client, simpleFetchHandler } from "@atcute/client";
import type {} from "@atcute/atproto";
import type { ContrailConfig, Database } from "./types";

// Slingshot-first PDS resolution with fallback to DID document resolution
const SLINGSHOT_URL =
  "https://slingshot.microcosm.blue/xrpc/com.bad-example.identity.resolveMiniDoc";

export interface ResolvedIdentity {
  did: string;
  handle: string | null;
  pds: string | null;
}

/** Reject external URLs (PDS, labeler, …) that point to private/internal
 *  addresses or non-HTTPS. The single SSRF guard shared across packages —
 *  callers MUST route every externally-resolved endpoint through this so the
 *  allowlist rules live in exactly one place.
 *
 *  Hostnames in `additionalAllowedHosts` skip both checks. Match is exact,
 *  case-insensitive (allowlist entries are lowercased on compare; `URL.hostname`
 *  is already lowercased), and port-agnostic.
 *
 *  Scope: best-effort guard against the obvious internal-address classes
 *  (private/link-local IPv4 literals, localhost, non-HTTPS). It does NOT
 *  resolve DNS, so a public hostname that resolves to a private address is not
 *  caught here, and IPv6 / non-canonical IP encodings are only partially
 *  covered. Defense-in-depth (egress network policy) is expected when resolver
 *  inputs are fully untrusted. */
export function validateExternalUrl(url: string, additionalAllowedHosts?: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (additionalAllowedHosts?.some((h) => h.toLowerCase() === parsed.hostname)) {
    return true;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  // Block private/internal IP ranges
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
  if (host.startsWith("10.")) return false;
  if (host.startsWith("192.168.")) return false;
  if (host.startsWith("169.254.")) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

async function resolveViaSlingshot(
  identifier: string,
  slingshotUrl: string,
): Promise<ResolvedIdentity | undefined> {
  const url = new URL(slingshotUrl);
  url.searchParams.set("identifier", identifier);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      did?: string;
      handle?: string;
      pds?: string;
    };
    if (!data.did && !data.pds) return undefined;
    return {
      did: data.did ?? identifier,
      handle: data.handle ?? null,
      pds: data.pds ?? null,
    };
  } catch {
    return undefined;
  }
}

const DEFAULT_DID_RESOLVER: DidDocumentResolver = new CompositeDidDocumentResolver({
  methods: {
    plc: new PlcDidDocumentResolver(),
    web: new WebDidDocumentResolver(),
  },
});

async function getPDSViaDidDoc(
  did: Did,
  config?: ContrailConfig,
): Promise<string | undefined> {
  const resolver = config?.networkOverrides?.resolver ?? DEFAULT_DID_RESOLVER;
  const doc = await resolver.resolve(did as Did<"plc"> | Did<"web">);
  return doc.service
    ?.find((s) => s.id === "#atproto_pds")
    ?.serviceEndpoint.toString();
}

/**
 * Resolve identity info (did, handle, pds) for a DID or handle.
 * Uses slingshot first, falls back to DID doc for PDS.
 *
 * `config?.networkOverrides` (optional): customize the slingshot endpoint,
 * the PLC URL used during DID-doc fallback, and/or which hostnames bypass
 * the default SSRF guard. Omitting `config` preserves all defaults.
 */
export async function resolvePDS(
  identifier: string,
  config?: ContrailConfig,
): Promise<ResolvedIdentity | undefined> {
  const slingshotUrl = config?.networkOverrides?.slingshotUrl ?? SLINGSHOT_URL;
  const allowed = config?.networkOverrides?.additionalAllowedHosts;
  const result = await resolveViaSlingshot(identifier, slingshotUrl);
  if (result?.pds) {
    if (!validateExternalUrl(result.pds, allowed)) return { ...result, pds: null };
    return result;
  }

  // Fall back to DID doc resolution (only works for DIDs, not handles)
  if (identifier.startsWith("did:")) {
    try {
      const pds = await getPDSViaDidDoc(identifier as Did, config);
      if (pds && validateExternalUrl(pds, allowed)) {
        return {
          did: identifier,
          handle: result?.handle ?? null,
          pds,
        };
      }
    } catch {
      // ignore
    }
  }

  return result;
}

// In-memory PDS cache with TTL + size limit, plus in-flight deduplication.
//
// Keyed by DID only — this assumes a single, process-wide `networkOverrides`
// config (the deployment model: one resolver + one SSRF allowlist per process).
// Every caller in this monorepo now threads the same in-scope `config`, so a
// config-less and an override-aware resolution can never race for the same DID.
// If a future deployment ever resolves the same DID under differing overrides
// in one process, key these caches by an override fingerprint instead.
const PDS_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const PDS_CACHE_MAX = 10_000;
const pdsCache = new Map<string, { pds: string; at: number }>();
const pdsInflight = new Map<string, Promise<string | undefined>>();

function pdsCacheGet(did: string): string | undefined {
  const entry = pdsCache.get(did);
  if (!entry) return undefined;
  if (Date.now() - entry.at > PDS_CACHE_TTL) {
    pdsCache.delete(did);
    return undefined;
  }
  return entry.pds;
}

function pdsCacheSet(did: string, pds: string): void {
  // Evict oldest entries if over limit
  if (pdsCache.size >= PDS_CACHE_MAX) {
    const first = pdsCache.keys().next().value;
    if (first) pdsCache.delete(first);
  }
  pdsCache.set(did, { pds, at: Date.now() });
}

export async function getPDS(
  did: Did,
  db?: Database,
  config?: ContrailConfig,
): Promise<string | undefined> {
  const mem = pdsCacheGet(did);
  if (mem) return mem;

  // Deduplicate concurrent calls for the same DID
  const inflight = pdsInflight.get(did);
  if (inflight) return inflight;

  const promise = resolvePDSCached(did, db, config);
  pdsInflight.set(did, promise);
  try {
    return await promise;
  } finally {
    pdsInflight.delete(did);
  }
}

async function resolvePDSCached(
  did: Did,
  db?: Database,
  config?: ContrailConfig,
): Promise<string | undefined> {
  let knownPds: string | undefined;
  if (db) {
    const cached = await db
      .prepare("SELECT pds, handle FROM identities WHERE did = ? AND pds IS NOT NULL")
      .bind(did)
      .first<{ pds: string; handle: string | null }>();
    if (cached?.pds) {
      pdsCacheSet(did, cached.pds);
      // A row with both a PDS and a handle is a complete cache hit. A row with
      // a PDS but no handle is a *partial* resolution — slingshot can return a
      // PDS without a handle under load — so fall through to re-resolve and
      // fill the handle instead of stranding the row forever (this DB
      // short-circuit previously meant the handle was never backfilled). We
      // keep serving the known PDS meanwhile, including if the re-resolve fails.
      if (cached.handle) return cached.pds;
      knownPds = cached.pds;
    }
  }

  const resolved = await resolvePDS(did, config);
  if (!resolved?.pds) return knownPds;

  pdsCacheSet(did, resolved.pds);

  // Persist to DB for future runs. COALESCE keeps an existing handle when this
  // resolution didn't return one, and never nulls a good handle.
  if (db) {
    await db
      .prepare(
        "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?) ON CONFLICT(did) DO UPDATE SET pds = excluded.pds, handle = COALESCE(excluded.handle, identities.handle), resolved_at = excluded.resolved_at"
      )
      .bind(did, resolved.handle, resolved.pds, Date.now())
      .run();
  }

  return resolved.pds;
}

export async function getClient(
  did: Did,
  db?: Database,
  config?: ContrailConfig,
): Promise<Client> {
  const pds = await getPDS(did, db, config);
  if (!pds) throw new Error(`PDS not found for ${did}`);
  return new Client({
    handler: simpleFetchHandler({ service: pds }),
  });
}

/** Test-only: clear module-level PDS caches. Production code MUST NOT call this.
 *  Exported with a `__` prefix to signal it is not part of the public API. */
export function __resetPdsCachesForTests(): void {
  pdsCache.clear();
  pdsInflight.clear();
}
