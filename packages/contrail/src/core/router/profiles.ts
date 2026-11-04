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

export async function resolveProfiles(
  db: Database,
  config: ContrailConfig,
  dids: string[],
): Promise<Record<string, ProfileEntry[]>> {
  if (dids.length === 0 || !config.profiles || config.profiles.length === 0) {
    return {};
  }

  const hiddenDids = await hiddenSubjects(db, dids);
  dids = dids.filter((did) => !hiddenDids.has(did));
  if (!dids.length) return {};
  const profileConfigs = config.profiles.map(normalizeProfileConfig);
  const result: Record<string, ProfileEntry[]> = {};
  const indexedUris = new Set<string>();
  const hiddenUris = await hiddenProfileUris(db, config, dids);
  dids = dids.filter(
    (did) =>
      !profileConfigs.every((p) =>
        hiddenUris.has(`at://${did}/${p.collection}/${p.rkey ?? "self"}`),
      ),
  );
  if (!dids.length) return {};

  // Batch-lookup profile records for each configured profile collection
  for (const pc of profileConfigs) {
    const { collection, rkey: configRkey, shortName } = pc;
    const rkey = configRkey ?? "self";
    const table = recordsTableName(shortName ?? collection);
    const uris = dids.map((did) => `at://${did}/${collection}/${rkey}`);

    const rows = await batchedInQuery<Omit<RecordRow, "collection">>(
      db,
      `SELECT uri, did, rkey, cid, record FROM ${table} r WHERE uri IN (__IN__) AND ${visibleRecordSql("r")}`,
      [],
      uris,
    );

    for (const row of rows) {
      indexedUris.add(row.uri);
      if (!result[row.did]) result[row.did] = [];
      result[row.did].push(formatProfile({ ...row, collection }));
    }
  }

  // Resolve identities for all DIDs
  const identities = await resolveIdentities(db, dids, config);

  // Fetch each missing (DID, profile collection) independently. One cached
  // profile collection must not make another configured collection look done.
  const missingProfiles = dids.flatMap((did) =>
    profileConfigs.flatMap((profile) => {
      const rkey = profile.rkey ?? "self";
      const uri = `at://${did}/${profile.collection}/${rkey}`;
      return indexedUris.has(uri) || hiddenUris.has(uri)
        ? []
        : [{ did, profile }];
    }),
  );
  if (missingProfiles.length > 0) {
    const fetched = await fetchMissingProfiles(db, config, missingProfiles);
    for (const [did, entries] of Object.entries(fetched)) {
      if (!result[did]) result[did] = [];
      result[did].push(...entries);
    }
  }

  // Recheck after network enrichment: moderation may have changed in flight.
  for (const did of await hiddenSubjects(db, dids)) {
    hiddenDids.add(did);
    delete result[did];
  }
  dids = dids.filter((did) => !hiddenDids.has(did));
  const currentHiddenUris = await hiddenProfileUris(db, config, dids);
  for (const did of dids) {
    if (result[did]) {
      result[did] = result[did].filter(
        (p) => !p.uri || !currentHiddenUris.has(p.uri),
      );
      if (!result[did].length) delete result[did];
    }
  }
  // Fill in handles and create entries for DIDs without profile records
  for (const did of dids) {
    const identity = identities.get(did);
    const handle = identity?.handle ?? null;

    if (result[did]) {
      for (const entry of result[did]) {
        entry.handle = handle;
      }
    } else if (
      !profileConfigs.some((p) =>
        currentHiddenUris.has(
          `at://${did}/${p.collection}/${p.rkey ?? "self"}`,
        ),
      )
    ) {
      // A genuinely absent profile may use an identity-only fallback, but a
      // hidden profile must stay absent (getProfile then returns 404).
      result[did] = [{ did, handle }];
    }
  }

  return result;
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
): Promise<Record<string, ProfileEntry[]>> {
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
  if (events.length === 0) return {};
  const { accepted } = await ingestRecords(db, events, config, {
    phase: "historical",
  });
  const result: Record<string, ProfileEntry[]> = {};
  for (const event of accepted) {
    if (event.operation === "delete") continue;
    const pc = (config.profiles ?? [])
      .map(normalizeProfileConfig)
      .find((p) => p.collection === event.collection);
    if (
      !pc ||
      !(await db
        .prepare(
          `SELECT 1 FROM ${recordsTableName(pc.shortName ?? pc.collection)} r WHERE uri = ? AND ${visibleRecordSql("r")}`,
        )
        .bind(event.uri)
        .first())
    )
      continue;
    if (!result[event.did]) result[event.did] = [];
    result[event.did].push(formatProfile(event));
  }
  return result;
}
