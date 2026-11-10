import type {
  Database,
  ContrailConfig,
  RecordRow,
  ProfileConfig,
} from "../types";
import { recordsTableName, normalizeProfileConfig } from "../types";
import { resolveIdentities } from "../identity";
import { getPDS } from "../client";
import { createIngestEvent, ingestRecords, recordTimeUs } from "../ingest";
import type { Did } from "@atcute/lexicons";
import { batchedInQuery, formatRecord } from "./helpers";
import type { SelfLabel } from "../labels/self";
import { visibleRecordSql, hiddenSubjects } from "../moderation";

export interface ProfileEntry {
  did: string;
  handle: string | null;
  uri?: string;
  cid?: string | null;
  value?: unknown;
  collection?: string;
  rkey?: string;
  /** Hydrated by the labels module when the caller has accepted-labelers
   *  active and there are matching labels on this DID. */
  labels?: unknown;
  /** Declarations on this profile record only, never DID-wide claims. */
  selfLabels?: SelfLabel[];
}

function formatProfile(row: RecordRow): ProfileEntry {
  const { did, uri, cid, value, collection, rkey, selfLabels } =
    formatRecord(row);
  return {
    did,
    handle: null,
    uri,
    cid,
    value,
    collection,
    rkey,
    ...(selfLabels?.length ? { selfLabels } : {}),
  };
}

export function collectDids(
  records: RecordRow[],
  hydrates: Record<string, Record<string, any[] | Record<string, any[]>>>,
): string[] {
  const dids = new Set(records.map((r) => r.did));
  for (const rels of Object.values(hydrates)) {
    for (const value of Object.values(rels)) {
      const items = Array.isArray(value) ? value : Object.values(value).flat();
      for (const item of items) {
        if (item.did) dids.add(item.did);
      }
    }
  }
  return [...dids];
}

/** Profile-URI hides are distinct from account hides. Include unpinned hides
 * even without a cached record, and match CID pins only to the indexed version.
 * Used before read-through so hidden profiles are not treated as cache misses. */
export async function hiddenProfileUris(
  db: Database,
  config: ContrailConfig,
  dids: string[],
): Promise<Set<string>> {
  const profiles = (config.profiles ?? []).map(normalizeProfileConfig);
  const uris = profiles.flatMap((p) =>
    dids.map((did) => `at://${did}/${p.collection}/${p.rkey ?? "self"}`),
  );
  const hidden = await hiddenSubjects(db, uris);
  for (const pc of profiles) {
    const rows = await batchedInQuery<{ uri: string }>(
      db,
      `SELECT uri FROM ${recordsTableName(pc.shortName ?? pc.collection)} r
       WHERE uri IN (__IN__) AND NOT (${visibleRecordSql("r")})`,
      [],
      dids.map((did) => `at://${did}/${pc.collection}/${pc.rkey ?? "self"}`),
    );
    for (const row of rows) hidden.add(row.uri);
  }
  return hidden;
}

const PROFILE_READ_BATCH_SIZE = 50;

interface IndexedProfileRow extends Omit<RecordRow, "collection"> {
  indexed_uri: string | null;
  identity_did: string | null;
  handle: string | null;
  hidden: number;
  miss_until: string | null;
}

/** Read profiles, handles, negative-cache entries and current visibility in one
 * statement per chunk/collection. Two bindings per DID keep each statement
 * within D1's 100-parameter limit. No network work happens in this helper. */
async function readIndexedProfiles(
  db: Database,
  profileConfigs: ProfileConfig[],
  dids: string[],
) {
  const result: Record<string, ProfileEntry[]> = {};
  const missingIdentities = new Set<string>();
  const missingProfiles: Array<{ did: string; profile: ProfileConfig }> = [];
  const handles = new Map<string, string | null>();
  const visibleDids = new Set<string>();
  const hiddenDids = new Set<string>();
  const now = Date.now();

  for (const profile of profileConfigs) {
    const { collection, shortName } = profile;
    const rkey = profile.rkey ?? "self";
    const table = recordsTableName(shortName ?? collection);
    for (let i = 0; i < dids.length; i += PROFILE_READ_BATCH_SIZE) {
      const chunk = dids.slice(i, i + PROFILE_READ_BATCH_SIZE);
      const { results: rows } = await db
        .prepare(
          `WITH requested(did, uri) AS (VALUES ${chunk.map(() => "(?, ?)").join(", ")}),
         candidates AS (
           SELECT requested.did, requested.uri, r.uri AS indexed_uri,
                  r.rkey, r.cid, r.record, r.time_us, r.indexed_at,
                  i.did AS identity_did, i.handle, m.value AS miss_until
           FROM requested
           LEFT JOIN ${table} r ON r.uri = requested.uri
           LEFT JOIN identities i ON i.did = requested.did
           LEFT JOIN _contrail_meta m ON m.key = 'profile-miss:' || requested.uri
         )
         SELECT p.*, CASE WHEN ${visibleRecordSql("p")} THEN 0 ELSE 1 END AS hidden
         FROM candidates p`,
        )
        .bind(
          ...chunk.flatMap((did) => [did, `at://${did}/${collection}/${rkey}`]),
        )
        .all<IndexedProfileRow>();

      for (const row of rows) {
        // requested.uri remains available even when the record is absent, so
        // unpinned profile hides suppress read-through and identity fallbacks.
        // A CID pin matches only the currently indexed version (p.cid).
        if (row.hidden) {
          hiddenDids.add(row.did);
          continue;
        }
        visibleDids.add(row.did);
        handles.set(row.did, row.handle);
        if (!row.identity_did) missingIdentities.add(row.did);
        if (row.indexed_uri) {
          (result[row.did] ??= []).push({
            ...formatProfile({ ...row, collection }),
            handle: row.handle,
          });
        } else if (!(Number(row.miss_until) > now)) {
          missingProfiles.push({ did: row.did, profile });
        }
      }
    }
  }

  for (const did of visibleDids) {
    // A genuinely absent profile may use an identity-only fallback. If any
    // configured profile is hidden, absence must not resurrect that fallback.
    if (!result[did] && !hiddenDids.has(did)) {
      result[did] = [{ did, handle: handles.get(did) ?? null }];
    }
  }
  return { result, missingIdentities: [...missingIdentities], missingProfiles };
}

export async function resolveProfiles(
  db: Database,
  config: ContrailConfig,
  dids: string[],
): Promise<Record<string, ProfileEntry[]>> {
  if (dids.length === 0 || !config.profiles || config.profiles.length === 0) {
    return {};
  }

  dids = [...new Set(dids)];
  const profileConfigs = config.profiles.map(normalizeProfileConfig);
  const indexed = await readIndexedProfiles(db, profileConfigs, dids);
  if (!indexed.missingIdentities.length && !indexed.missingProfiles.length) {
    return indexed.result;
  }

  // Only genuinely missing identities need a second lookup or resolution;
  // indexed handles and live negative-cache entries stay on the fast path.
  if (indexed.missingIdentities.length) {
    await resolveIdentities(db, indexed.missingIdentities, config);
  }
  if (indexed.missingProfiles.length) {
    await fetchMissingProfiles(db, config, indexed.missingProfiles);
  }

  // Network enrichment may overlap moderation changes, deletions, or a newer
  // indexed version. Re-read durable state instead of merging stale snapshots
  // or returning fetched records that ingestion did not admit.
  return (await readIndexedProfiles(db, profileConfigs, dids)).result;
}

/**
 * Fetch profile records from PDS for DIDs not yet in the index.
 * Fetches in parallel across all configured profile collections,
 * indexes the results into D1 for future requests.
 */
async function fetchMissingProfiles(
  db: Database,
  config: ContrailConfig,
  missing: Array<{ did: string; profile: ProfileConfig }>,
): Promise<void> {
  // Persistent per-profile negative cache without new schema. Always look up
  // indexed records first, so live ingestion bypasses an outstanding miss.
  const missKey = (uri: string) => `profile-miss:${uri}`;
  const keys = missing.map(({ did, profile }) =>
    missKey(`at://${did}/${profile.collection}/${profile.rkey ?? "self"}`),
  );
  const cached = await batchedInQuery<{ key: string; value: string }>(
    db,
    "SELECT key, value FROM _contrail_meta WHERE key IN (__IN__)",
    [],
    keys,
  );
  const skip = new Set(
    cached.filter((r) => Number(r.value) > Date.now()).map((r) => r.key),
  );
  const misses: Array<{ key: string; until: number }> = [];
  const fetched = await Promise.all(
    missing.map(async ({ did, profile }) => {
      const { collection, rkey: configRkey } = profile;
      const rkey = configRkey ?? "self";
      const uri = `at://${did}/${collection}/${rkey}`;
      if (skip.has(missKey(uri))) return null;
      const miss = (duration = 3_600_000) => {
        misses.push({ key: missKey(uri), until: Date.now() + duration });
        return null;
      };
      try {
        const pds = await getPDS(did as Did, db, config);
        if (!pds) return miss();

        const url = new URL("/xrpc/com.atproto.repo.getRecord", pds);
        url.searchParams.set("repo", did);
        url.searchParams.set("collection", collection);
        url.searchParams.set("rkey", rkey);

        const response = await fetch(url.toString(), {
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
          // Only authoritative absence gets a day-long cache. Transient server
          // errors, auth failures and unavailable accounts retry within an hour.
          const failure = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          return miss(
            failure?.error === "RecordNotFound" ? 86_400_000 : 3_600_000,
          );
        }
        const data = (await response.json()) as {
          uri?: string;
          value?: unknown;
          cid?: string;
        };
        if (!data.value || !data.cid || (data.uri && data.uri !== uri)) {
          return miss();
        }

        const nowUs = Date.now() * 1000;
        return createIngestEvent({
          uri,
          did,
          collection,
          rkey,
          operation: "create",
          cid: data.cid,
          value: data.value,
          timeUs: recordTimeUs(data.value, collection, config, nowUs),
          indexedAt: nowUs,
          source: {
            id: "pds-profile",
            time_us: nowUs,
            revision: null,
            cursor: null,
          },
        });
      } catch {
        return miss();
      }
    }),
  );
  if (misses.length) {
    await db.batch(
      misses.map(({ key, until }) =>
        db
          .prepare(
            "INSERT INTO _contrail_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .bind(key, String(until)),
      ),
    );
  }

  const events = fetched.filter((event) => event !== null);
  if (events.length === 0) return;
  await ingestRecords(db, events, config, { phase: "historical" });
}
