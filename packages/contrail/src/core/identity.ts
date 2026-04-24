import type { Did } from "@atcute/lexicons";
import type { Database, Logger } from "./types";
import { isDid, isHandle } from "@atcute/lexicons/syntax";
import { resolvePDS } from "./client";

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface Identity {
  did: string;
  handle: string | null;
  pds: string | null;
  resolved_at: number;
}

async function saveIdentity(db: Database, identity: Identity): Promise<void> {
  await db
    .prepare(
      "INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?) ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, pds = excluded.pds, resolved_at = excluded.resolved_at"
    )
    .bind(identity.did, identity.handle, identity.pds, identity.resolved_at)
    .run();
}

function isStale(resolvedAt: number): boolean {
  return Date.now() - resolvedAt >= STALE_MS;
}

async function fetchAndSave(
  db: Database,
  identifier: string,
  cached?: Identity | null
): Promise<Identity> {
  const resolved = await resolvePDS(identifier);
  const identity: Identity = {
    did: resolved?.did ?? identifier,
    handle: resolved?.handle ?? cached?.handle ?? null,
    pds: resolved?.pds ?? cached?.pds ?? null,
    resolved_at: Date.now(),
  };
  await saveIdentity(db, identity);
  return identity;
}

export async function resolveIdentity(
  db: Database,
  did: Did
): Promise<Identity> {
  const cached = await db
    .prepare("SELECT did, handle, pds, resolved_at FROM identities WHERE did = ?")
    .bind(did)
    .first<Identity>();

  if (cached && !isStale(cached.resolved_at)) return cached;

  return fetchAndSave(db, did, cached);
}

export async function resolveIdentities(
  db: Database,
  dids: string[]
): Promise<Map<string, Identity>> {
  const map = new Map<string, Identity>();
  if (dids.length === 0) return map;

  // Batch lookup from DB
  const BATCH = 50;
  for (let i = 0; i < dids.length; i += BATCH) {
    const chunk = dids.slice(i, i + BATCH);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT did, handle, pds, resolved_at FROM identities WHERE did IN (${placeholders})`)
      .bind(...chunk)
      .all<Identity>();
    for (const row of rows.results ?? []) {
      map.set(row.did, row);
    }
  }

  // Resolve missing via slingshot directly (no redundant DB lookup)
  for (const did of dids) {
    if (map.has(did) || !isDid(did)) continue;
    try {
      const identity = await fetchAndSave(db, did);
      map.set(did, identity);
    } catch {
      // Silently skip unresolvable identities
    }
  }

  return map;
}

export async function resolveActor(
  db: Database,
  actor: string
): Promise<string | null> {
  if (isDid(actor)) return actor;
  if (!isHandle(actor)) return null;

  // Look up handle in identities table
  const cached = await db
    .prepare("SELECT did, resolved_at FROM identities WHERE handle = ?")
    .bind(actor)
    .first<{ did: string; resolved_at: number }>();

  if (cached && !isStale(cached.resolved_at)) return cached.did;

  // Resolve via slingshot
  const resolved = await resolvePDS(actor);
  if (!resolved?.did || !isDid(resolved.did)) return null;

  await saveIdentity(db, {
    did: resolved.did,
    handle: resolved.handle ?? actor,
    pds: resolved.pds ?? null,
    resolved_at: Date.now(),
  });

  return resolved.did;
}

export async function refreshStaleIdentities(
  db: Database,
  dids: string[]
): Promise<void> {
  if (dids.length === 0) return;

  const unique = [...new Set(dids)].filter(isDid);
  if (unique.length === 0) return;

  const staleThreshold = Date.now() - STALE_MS;
  const toRefresh: string[] = [];

  const BATCH = 50;
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT did, resolved_at FROM identities WHERE did IN (${placeholders})`)
      .bind(...chunk)
      .all<{ did: string; resolved_at: number }>();

    const found = new Map((rows.results ?? []).map((r) => [r.did, r.resolved_at]));
    for (const did of chunk) {
      const resolvedAt = found.get(did);
      if (resolvedAt === undefined || resolvedAt < staleThreshold) {
        toRefresh.push(did);
      }
    }
  }

  for (const did of toRefresh) {
    try {
      await fetchAndSave(db, did);
    } catch {
      // Silently skip unresolvable identities
    }
  }
}
