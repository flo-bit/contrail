import type { Database, ContrailConfig, RecordRow } from "../types";
import { recordsTableName } from "../types";
import { resolveIdentities } from "../identity";
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
): Promise<Record<string, ProfileEntry>> {
  if (dids.length === 0 || !config.profiles || config.profiles.length === 0) {
    return {};
  }

  const result: Record<string, ProfileEntry> = {};

  // Batch-lookup profile records for each configured profile collection (first match wins)
  for (const collection of config.profiles) {
    const remaining = dids.filter((d) => !result[d]);
    if (remaining.length === 0) break;

    const table = recordsTableName(collection);
    const uris = remaining.map((did) => `at://${did}/${collection}/self`);

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
      result[row.did] = {
        did: row.did,
        handle: null, // filled below
        uri: row.uri,
        collection,
        rkey: row.rkey,
        cid: row.cid,
        record,
      };
    }
  }

  // Resolve identities for all DIDs
  const identities = await resolveIdentities(db, dids);

  // Fill in handles and create entries for DIDs without profile records
  for (const did of dids) {
    const identity = identities.get(did);
    const handle = identity?.handle ?? null;

    if (result[did]) {
      result[did].handle = handle;
    } else {
      result[did] = { did, handle };
    }
  }

  return result;
}
