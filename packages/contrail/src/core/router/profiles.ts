import type { Database, ContrailConfig, RecordRow, ProfileConfig } from "../types";
import { recordsTableName, normalizeProfileConfig } from "../types";
import { resolveIdentities } from "../identity";
import { getPDS } from "../client";
import type { Did } from "@atcute/lexicons";
import { batchedInQuery } from "./helpers";

export interface ProfileEntry {
  did: string;
  handle: string | null;
  uri?: string;
  collection?: string;
  rkey?: string;
  cid?: string | null;
  record?: any;
}

export function collectDids(
  records: RecordRow[],
  hydrates: Record<string, Record<string, any[] | Record<string, any[]>>>
): string[] {
  const dids = new Set(records.map((r) => r.did));
  for (const rels of Object.values(hydrates)) {
    for (const value of Object.values(rels)) {
      const items = Array.isArray(value)
        ? value
        : Object.values(value).flat();
      for (const item of items) {
        if (item.did) dids.add(item.did);
      }
    }
  }
  return [...dids];
}

export async function resolveProfiles(
  db: Database,
  config: ContrailConfig,
  dids: string[]
): Promise<Record<string, ProfileEntry[]>> {
  if (dids.length === 0 || !config.profiles || config.profiles.length === 0) {
    return {};
  }

  const profileConfigs = config.profiles.map(normalizeProfileConfig);
  const result: Record<string, ProfileEntry[]> = {};

  // Batch-lookup profile records for each configured profile collection
  for (const pc of profileConfigs) {
    const { collection, rkey: configRkey, shortName } = pc;
    const rkey = configRkey ?? "self";
    const table = recordsTableName(shortName ?? collection);
    const uris = dids.map((did) => `at://${did}/${collection}/${rkey}`);

    const rows = await batchedInQuery<Omit<RecordRow, "collection">>(
      db,
      `SELECT uri, did, rkey, cid, record FROM ${table} WHERE uri IN (__IN__)`,
      [],
      uris
    );

    for (const row of rows) {
      let record = null;
      if (row.record) {
        try {
          record = JSON.parse(row.record);
        } catch {
          record = row.record;
        }
      }
      if (!result[row.did]) result[row.did] = [];
      result[row.did].push({
        did: row.did,
        handle: null, // filled below
        uri: row.uri,
        collection,
        rkey: row.rkey,
        cid: row.cid,
        record,
      });
    }
  }

  // Resolve identities for all DIDs
  const identities = await resolveIdentities(db, dids);

  // Fetch missing profile records from PDS on demand
  const missingDids = dids.filter((d) => !result[d]);
  if (missingDids.length > 0 && profileConfigs.length > 0) {
    const fetched = await fetchMissingProfiles(db, config, missingDids);
    for (const [did, entries] of Object.entries(fetched)) {
      if (!result[did]) result[did] = [];
      result[did].push(...entries);
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
    } else {
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
  dids: string[]
): Promise<Record<string, ProfileEntry[]>> {
  const result: Record<string, ProfileEntry[]> = {};
  const profileConfigs = config.profiles!.map(normalizeProfileConfig);

  await Promise.all(
    dids.flatMap((did) =>
      profileConfigs.map(async (pc) => {
        const { collection, rkey: configRkey, shortName } = pc;
        const rkey = configRkey ?? "self";
        const table = recordsTableName(shortName ?? collection);
        try {
          const pds = await getPDS(did as Did, db);
          if (!pds) return;

          const url = new URL("/xrpc/com.atproto.repo.getRecord", pds);
          url.searchParams.set("repo", did);
          url.searchParams.set("collection", collection);
          url.searchParams.set("rkey", rkey);

          const res = await fetch(url.toString());
          if (!res.ok) return;

          const data = (await res.json()) as { uri?: string; value?: unknown; cid?: string };
          if (!data.value || !data.cid) return;

          const uri = data.uri ?? `at://${did}/${collection}/${rkey}`;
          const record = data.value;
          const cid = data.cid;

          // Index into D1 for future requests
          await db
            .prepare(
              `INSERT INTO ${table} (uri, did, rkey, cid, record, time_us, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, record = excluded.record, indexed_at = excluded.indexed_at`
            )
            .bind(uri, did, rkey, cid, JSON.stringify(record), Date.now() * 1000, Date.now())
            .run();

          if (!result[did]) result[did] = [];
          result[did].push({
            did,
            handle: null,
            uri,
            collection,
            rkey,
            cid,
            record,
          });
        } catch {
          // Skip failures silently
        }
      })
    )
  );

  return result;
}
