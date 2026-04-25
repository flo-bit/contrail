import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
} from "@atcute/identity-resolver";
import type { Did } from "@atcute/lexicons";
import type { Database } from "../types";

/** Reject endpoint URLs that point to private/internal addresses or non-HTTPS.
 *  Mirrors the validator in core/client.ts — labeler endpoints should be
 *  publicly reachable for the same reasons PDS endpoints should. */
function validateEndpointUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
    if (host.startsWith("10.")) return false;
    if (host.startsWith("192.168.")) return false;
    if (host.startsWith("169.254.")) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

const didResolver = new CompositeDidDocumentResolver({
  methods: {
    plc: new PlcDidDocumentResolver(),
    web: new WebDidDocumentResolver(),
  },
});

/** Look up the labeler service endpoint from a DID.
 *  Reads the DID doc's `service[id="#atproto_labeler"].serviceEndpoint`. */
export async function resolveLabelerEndpoint(did: string): Promise<string | null> {
  if (!did.startsWith("did:plc:") && !did.startsWith("did:web:")) return null;
  try {
    const doc = await didResolver.resolve(did as Did<"plc"> | Did<"web">);
    const endpoint = doc.service
      ?.find((s) => s.id === "#atproto_labeler")
      ?.serviceEndpoint?.toString();
    if (!endpoint) return null;
    if (!validateEndpointUrl(endpoint)) return null;
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
 *  so subsequent ingest cycles avoid the network round-trip. */
export async function getLabelerState(
  db: Database,
  did: string,
  endpointOverride: string | undefined,
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
    endpoint = await resolveLabelerEndpoint(did);
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
