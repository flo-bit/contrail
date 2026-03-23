import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
} from "@atcute/identity-resolver";
import { type Did } from "@atcute/lexicons";
import { Client, simpleFetchHandler } from "@atcute/client";
import type {} from "@atcute/atproto";
import type { Database } from "./types";

// Slingshot-first PDS resolution with fallback to DID document resolution
const SLINGSHOT_URL =
  "https://slingshot.microcosm.blue/xrpc/com.bad-example.identity.resolveMiniDoc";

export interface ResolvedIdentity {
  did: string;
  handle: string | null;
  pds: string | null;
}

async function resolveViaSlingshot(
  identifier: string
): Promise<ResolvedIdentity | undefined> {
  const url = new URL(SLINGSHOT_URL);
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

const didResolver = new CompositeDidDocumentResolver({
  methods: {
    plc: new PlcDidDocumentResolver(),
    web: new WebDidDocumentResolver(),
  },
});

async function getPDSViaDidDoc(did: Did): Promise<string | undefined> {
  const doc = await didResolver.resolve(did as Did<"plc"> | Did<"web">);
  return doc.service
    ?.find((s) => s.id === "#atproto_pds")
    ?.serviceEndpoint.toString();
}

/**
 * Resolve identity info (did, handle, pds) for a DID or handle.
 * Uses slingshot first, falls back to DID doc for PDS.
 */
export async function resolvePDS(
  identifier: string
): Promise<ResolvedIdentity | undefined> {
  const result = await resolveViaSlingshot(identifier);
  if (result?.pds) return result;

  // Fall back to DID doc resolution (only works for DIDs, not handles)
  if (identifier.startsWith("did:")) {
    try {
      const pds = await getPDSViaDidDoc(identifier as Did);
      if (pds) {
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

// In-memory PDS cache + in-flight deduplication
const pdsCache = new Map<string, string>();
const pdsInflight = new Map<string, Promise<string | undefined>>();

export async function getPDS(
  did: Did,
  db?: Database
): Promise<string | undefined> {
  const mem = pdsCache.get(did);
  if (mem) return mem;

  // Deduplicate concurrent calls for the same DID
  const inflight = pdsInflight.get(did);
  if (inflight) return inflight;

  const promise = resolvePDSCached(did, db);
  pdsInflight.set(did, promise);
  try {
    return await promise;
  } finally {
    pdsInflight.delete(did);
  }
}

async function resolvePDSCached(
  did: Did,
  db?: Database
): Promise<string | undefined> {
  if (db) {
    const cached = await db
      .prepare("SELECT pds FROM identities WHERE did = ? AND pds IS NOT NULL")
      .bind(did)
      .first<{ pds: string }>();
    if (cached?.pds) {
      pdsCache.set(did, cached.pds);
      return cached.pds;
    }
  }

  const resolved = await resolvePDS(did);
  if (!resolved?.pds) return undefined;

  pdsCache.set(did, resolved.pds);

  // Persist to DB for future runs
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

export async function getClient(did: Did, db?: Database): Promise<Client> {
  const pds = await getPDS(did, db);
  if (!pds) throw new Error(`PDS not found for ${did}`);
  return new Client({
    handler: simpleFetchHandler({ service: pds }),
  });
}
