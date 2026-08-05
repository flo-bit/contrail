import {
  CompositeDidDocumentResolver,
  type DidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
} from "@atcute/identity-resolver";
import type { Did } from "@atcute/lexicons";
import type { Database } from "../types";
import { validateExternalUrl } from "../client";

/** Optional network-override knobs accepted by labeler-endpoint resolution.
 *  Mirrors the `ContrailConfig.networkOverrides` shape — kept narrow here so
 *  callers can pass `config.networkOverrides` directly without re-shaping.
 *  Omitting the object preserves the previous public-internet behavior. */
export interface LabelerResolveOverrides {
  /** DID document resolver used when looking up the labeler service entry.
   *  When unset, falls back to a default composite (PLC + Web) pointing at the
   *  upstream PLC directory. Trusted; not SSRF-checked.
   *  Mirrors the resolver-injection pattern in `core/client.ts`. */
  resolver?: DidDocumentResolver;
  /** Hostnames (DNS names or IP literals) to allow past the default SSRF
   *  guard when validating a resolved labeler endpoint. Match is exact,
   *  case-insensitive, port-agnostic. */
  additionalAllowedHosts?: string[];
}

/** Reject endpoint URLs that point to private/internal addresses or non-HTTPS.
 *  Thin alias for the single shared SSRF guard {@link validateExternalUrl} in
 *  `contrail-base` — labeler endpoints are validated by the exact same rules as
 *  PDS endpoints, so the allowlist logic must live in one place. Kept exported
 *  under this name for existing callers/tests. */
export const validateEndpointUrl = validateExternalUrl;

const DEFAULT_DID_RESOLVER: DidDocumentResolver = new CompositeDidDocumentResolver({
  methods: {
    plc: new PlcDidDocumentResolver(),
    web: new WebDidDocumentResolver(),
  },
});

/** Look up the labeler service endpoint from a DID.
 *  Reads the DID doc's `service[id="#atproto_labeler"].serviceEndpoint`.
 *
 *  `networkOverrides` (optional): customize the DID resolver used during the
 *  lookup, and/or which hostnames bypass the default SSRF guard. Omitting it
 *  preserves the original public-internet behavior. */
export async function resolveLabelerEndpoint(
  did: string,
  networkOverrides?: LabelerResolveOverrides,
): Promise<string | null> {
  if (!did.startsWith("did:plc:") && !did.startsWith("did:web:")) return null;
  const resolver = networkOverrides?.resolver ?? DEFAULT_DID_RESOLVER;
  try {
    const doc = await resolver.resolve(did as Did<"plc"> | Did<"web">);
    const endpoint = doc.service
      ?.find((s) => s.id === "#atproto_labeler")
      ?.serviceEndpoint?.toString();
    if (!endpoint) return null;
    if (!validateEndpointUrl(endpoint, networkOverrides?.additionalAllowedHosts ?? [])) {
      return null;
    }
    return endpoint;
  } catch {
    return null;
  }
}

/** State row for a labeler — the per-DID equivalent of the singleton
 *  jetstream `cursor` table, with cached endpoint to avoid repeated DID-doc
 *  fetches. */
export interface LabelerState {
  did: string;
  cursor: number;
  endpoint: string | null;
  resolved_at: number | null;
}

const ENDPOINT_TTL_MS = 6 * 60 * 60 * 1000; // 6h, matches the recommended client cache for label-defs

/** Get cached `(endpoint, cursor)` for a labeler. Resolves endpoint on
 *  cache miss or staleness; persists endpoint + resolved_at back to the DB
 *  so subsequent ingest cycles avoid the network round-trip.
 *
 *  `networkOverrides` (optional): forwarded to `resolveLabelerEndpoint` for
 *  the cache-miss/stale path. Has no effect when `endpointOverride` is set
 *  or when a fresh cached endpoint is used. */
export async function getLabelerState(
  db: Database,
  did: string,
  endpointOverride: string | undefined,
  networkOverrides?: LabelerResolveOverrides,
): Promise<LabelerState | null> {
  const row = await db
    .prepare(
      "SELECT did, cursor, endpoint, resolved_at FROM labeler_cursors WHERE did = ?",
    )
    .bind(did)
    .first<LabelerState>();

  let endpoint = endpointOverride ?? row?.endpoint ?? null;
  const stale =
    !row?.resolved_at || Date.now() - row.resolved_at > ENDPOINT_TTL_MS;

  if (!endpoint || (!endpointOverride && stale)) {
    endpoint = await resolveLabelerEndpoint(did, networkOverrides);
    if (!endpoint) return null;
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO labeler_cursors (did, cursor, endpoint, resolved_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(did) DO UPDATE SET endpoint = excluded.endpoint, resolved_at = excluded.resolved_at`,
      )
      .bind(did, row?.cursor ?? 0, endpoint, now)
      .run();
    return {
      did,
      cursor: row?.cursor ?? 0,
      endpoint,
      resolved_at: now,
    };
  }

  return row ?? { did, cursor: 0, endpoint, resolved_at: null };
}

/** Persist the highest seen seq number for a labeler. Idempotent;
 *  the next ingest cycle resumes from `cursor + 1` via the `?cursor=` param. */
export async function saveLabelerCursor(
  db: Database,
  did: string,
  cursor: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO labeler_cursors (did, cursor)
         VALUES (?, ?)
         ON CONFLICT(did) DO UPDATE SET cursor = excluded.cursor`,
    )
    .bind(did, cursor)
    .run();
}

/** Reset cursor to 0 — used in response to `#info { name: "OutdatedCursor" }`
 *  frames, which signal that the labeler's seq history was rewound. */
export async function resetLabelerCursor(db: Database, did: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO labeler_cursors (did, cursor)
         VALUES (?, 0)
         ON CONFLICT(did) DO UPDATE SET cursor = 0`,
    )
    .bind(did)
    .run();
}
