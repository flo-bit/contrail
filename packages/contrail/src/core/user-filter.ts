import type { ContrailConfig, Database, UserFilterInput } from "./types";

/**
 * Run `config.userFilter` against a freshly resolved identity. When the
 * filter returns true the user is marked excluded (`identities.excluded = 1`)
 * and any pending backfill rows are dropped so the bulk loop won't enumerate
 * them again. Safe to call repeatedly.
 *
 * Returns true if the user is now excluded.
 */
export async function checkUserFilter(
  db: Database,
  identity: UserFilterInput,
  config: ContrailConfig | undefined
): Promise<boolean> {
  if (!config?.userFilter) return false;
  let excluded = false;
  try {
    excluded = !!config.userFilter(identity);
  } catch (err) {
    (config.logger ?? console).warn(
      `[userFilter] threw for ${identity.did}: ${err}`
    );
    return false;
  }
  if (!excluded) return false;
  await db
    .prepare("UPDATE identities SET excluded = 1 WHERE did = ?")
    .bind(identity.did)
    .run();
  await db
    .prepare("DELETE FROM backfills WHERE did = ?")
    .bind(identity.did)
    .run();
  return true;
}

/** True if `identities.excluded = 1` for this DID. */
export async function isExcluded(db: Database, did: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT excluded FROM identities WHERE did = ?")
    .bind(did)
    .first<{ excluded: number }>();
  return !!row?.excluded;
}

export interface UserFilterSweepResult {
  /** Identities the filter newly marked excluded during this sweep. */
  newlyExcluded: number;
  /** Total identities marked excluded after the sweep. */
  totalExcluded: number;
}

/**
 * Apply `config.userFilter` to every identity that isn't already excluded.
 * Catches users that were resolved BEFORE the filter was added to config —
 * fresh resolutions filter at write time, but cached identities would
 * otherwise stay un-filtered until their next stale refresh.
 *
 * If no filter is configured, this still returns the current excluded count.
 */
export async function sweepUserFilter(
  db: Database,
  config: ContrailConfig | undefined
): Promise<UserFilterSweepResult> {
  let newlyExcluded = 0;

  if (config?.userFilter) {
    const BATCH = 500;
    let lastDid = "";
    while (true) {
      const rows = await db
        .prepare(
          "SELECT did, handle, pds FROM identities WHERE excluded = 0 AND did > ? ORDER BY did LIMIT ?"
        )
        .bind(lastDid, BATCH)
        .all<{ did: string; handle: string | null; pds: string | null }>();
      const list = rows.results ?? [];
      if (list.length === 0) break;
      for (const r of list) {
        if (await checkUserFilter(db, r, config)) newlyExcluded++;
      }
      lastDid = list[list.length - 1].did;
      if (list.length < BATCH) break;
    }
  }

  const total = await db
    .prepare("SELECT COUNT(*) AS c FROM identities WHERE excluded = 1")
    .first<{ c: number }>();
  return { newlyExcluded, totalExcluded: Number(total?.c ?? 0) };
}
