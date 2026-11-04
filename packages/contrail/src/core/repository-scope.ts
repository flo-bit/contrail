import type { ContrailConfig, Database } from "./types";
import { collectionAcquisition, recordsTableName } from "./types";

export const REPOSITORY_SCOPES_KEY = "repository_scopes";

/** Scope is durable projection policy, not a mutable query/transport filter.
 * Existing scopes cannot change without rebuilding the projection. New scoped
 * collections may be added to a populated AppView if they have no prior state. */
export async function ensureRepositoryScopes(
  db: Database,
  config: ContrailConfig,
  stored: string | undefined,
): Promise<void> {
  const previous: Record<string, string[]> = stored ? JSON.parse(stored) : {};
  // Keep omitted collections registered, so removing and re-adding an alias
  // cannot accidentally bypass the rebuild requirement.
  const next = { ...previous };
  for (const [short, collection] of Object.entries(config.collections)) {
    const nsid = collection.collection ?? short;
    const policy = collectionAcquisition(collection);
    const repos = policy.mode === "repos" ? [...policy.repos].sort() : undefined;
    if (previous[nsid]) {
      if (JSON.stringify(previous[nsid]) !== JSON.stringify(repos)) {
        throw new Error(
          `Repository scope changed for ${nsid}; rebuild the projection database before changing repos`,
        );
      }
    } else if (repos) {
      const existing = await db
        .prepare(`SELECT 1 AS present FROM ${recordsTableName(short)} LIMIT 1`)
        .first();
      const historical = await db
        .prepare(
          "SELECT 1 AS present FROM record_versions WHERE collection = ? UNION ALL SELECT 1 AS present FROM backfills WHERE collection = ? UNION ALL SELECT 1 AS present FROM discovery WHERE collection = ? LIMIT 1",
        )
        .bind(nsid, nsid, nsid)
        .first();
      if (existing || historical) {
        throw new Error(
          `Cannot apply repository scope to populated collection ${nsid}; rebuild the projection database first`,
        );
      }
      next[nsid] = repos;
    }
  }
  const entries = Object.entries(next).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return;
  const value = JSON.stringify(Object.fromEntries(entries));
  if (value === stored) return;
  if (stored === undefined) {
    await db
      .prepare("INSERT INTO _contrail_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      .bind(REPOSITORY_SCOPES_KEY, value)
      .run();
  } else {
    await db
      .prepare("UPDATE _contrail_meta SET value = ? WHERE key = ? AND value = ?")
      .bind(value, REPOSITORY_SCOPES_KEY, stored)
      .run();
  }
  const saved = await db
    .prepare("SELECT value FROM _contrail_meta WHERE key = ?")
    .bind(REPOSITORY_SCOPES_KEY)
    .first<{ value: string }>();
  if (saved?.value !== value) {
    throw new Error("Repository scope initialization raced a different configuration; retry initialization");
  }
}

/** Seed exact pairs without adding these publishers to dependent collections.
 * Existing completion, retry and pagination state survives initialization. */
export async function seedRepositoryBackfills(
  db: Database,
  config: ContrailConfig,
): Promise<void> {
  for (const [short, collection] of Object.entries(config.collections)) {
    const policy = collectionAcquisition(collection);
    if (policy.mode !== "repos") continue;
    for (const did of policy.repos) {
      await db
        .prepare("INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 0) ON CONFLICT DO NOTHING")
        .bind(did, collection.collection ?? short)
        .run();
    }
  }
}
