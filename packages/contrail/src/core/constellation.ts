import { isDid } from "@atcute/lexicons/syntax";
import type { ContrailConfig, Database, Logger } from "./types";
import {
  DEFAULT_CONSTELLATION_URL,
  DEFAULT_FOLLOW_NSID,
  recordsTableName,
  shortNameForNsid,
} from "./types";

const PAGE_LIMIT = 100;
const DID_FILTER_CHUNK = 50;

interface BacklinksPage {
  links?: Array<{
    did?: string;
    rkey?: string;
    /** Some Constellation versions return the full URI rather than did/rkey split. */
    uri?: string;
  }>;
  cursor?: string;
}

function getLogger(config: ContrailConfig): Logger {
  return config.logger ?? console;
}

/** Resolve effective Constellation config; null when disabled. */
function getConstellationSettings(
  config: ContrailConfig
): { url: string; userAgent: string } | null {
  const c = config.constellation;
  if (c === false) return null;
  if (c?.enabled === false) return null;
  return {
    url: c?.url ?? DEFAULT_CONSTELLATION_URL,
    userAgent: c?.userAgent ?? `contrail/${config.namespace}`,
  };
}

/** Find the configured short name for `app.bsky.graph.follow`, if any. */
function getFollowShort(config: ContrailConfig): string | null {
  const short = shortNameForNsid(config, DEFAULT_FOLLOW_NSID);
  return short ?? null;
}

interface BacklinkRow {
  did: string;
  rkey: string;
  uri: string;
}

function parseBacklink(entry: NonNullable<BacklinksPage["links"]>[number]): BacklinkRow | null {
  if (entry.did && entry.rkey && isDid(entry.did)) {
    return {
      did: entry.did,
      rkey: entry.rkey,
      uri: entry.uri ?? `at://${entry.did}/${DEFAULT_FOLLOW_NSID}/${entry.rkey}`,
    };
  }
  if (entry.uri) {
    const m = /^at:\/\/(did:[^/]+)\/[^/]+\/([^/]+)$/.exec(entry.uri);
    if (m && isDid(m[1])) {
      return { did: m[1], rkey: m[2], uri: entry.uri };
    }
  }
  return null;
}

/** Filter a candidate-follower DID list to those already in our identities table. */
async function filterKnownDids(
  db: Database,
  candidates: string[]
): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < candidates.length; i += DID_FILTER_CHUNK) {
    const chunk = candidates.slice(i, i + DID_FILTER_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT did FROM identities WHERE did IN (${placeholders})`)
      .bind(...chunk)
      .all<{ did: string }>();
    for (const r of rows.results ?? []) known.add(r.did);
  }
  return known;
}

/** Fetch one page of getBacklinks. Returns null on non-2xx (caller decides whether to bail). */
async function fetchBacklinksPage(
  url: string,
  userAgent: string,
  subject: string,
  cursor?: string
): Promise<BacklinksPage | null> {
  const u = new URL("/xrpc/blue.microcosm.links.getBacklinks", url);
  u.searchParams.set("subject", subject);
  u.searchParams.set("source", `${DEFAULT_FOLLOW_NSID}:.subject`);
  u.searchParams.set("limit", String(PAGE_LIMIT));
  if (cursor) u.searchParams.set("cursor", cursor);
  try {
    const res = await fetch(u.toString(), {
      headers: { "user-agent": userAgent, accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as BacklinksPage;
  } catch {
    return null;
  }
}

/** For a newly-known subject DID, find existing followers via Constellation
 *  and ingest synthesized follow records into the configured follow table.
 *  Best-effort: failures are logged but not retried (caller can re-trigger). */
export async function backfillFollowersFromConstellation(
  db: Database,
  config: ContrailConfig,
  subjectDid: string
): Promise<number> {
  const settings = getConstellationSettings(config);
  if (!settings) return 0;
  if (!isDid(subjectDid)) return 0;
  const followShort = getFollowShort(config);
  if (!followShort) return 0;
  const log = getLogger(config);

  const followTable = recordsTableName(followShort);
  const recordJson = JSON.stringify({
    $type: DEFAULT_FOLLOW_NSID,
    subject: subjectDid,
    createdAt: new Date().toISOString(),
  });
  const nowUs = Date.now() * 1000;

  let cursor: string | undefined;
  let inserted = 0;
  let pages = 0;

  while (true) {
    const page = await fetchBacklinksPage(
      settings.url,
      settings.userAgent,
      subjectDid,
      cursor
    );
    if (!page) break;
    pages++;

    const rows: BacklinkRow[] = (page.links ?? [])
      .map(parseBacklink)
      .filter((r): r is BacklinkRow => r !== null && r.did !== subjectDid);

    if (rows.length > 0) {
      const known = await filterKnownDids(
        db,
        rows.map((r) => r.did)
      );
      const survivors = rows.filter((r) => known.has(r.did));

      for (const r of survivors) {
        const result = await db
          .prepare(
            `INSERT INTO ${followTable} (uri, did, rkey, cid, record, time_us, indexed_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?)
             ON CONFLICT(uri) DO NOTHING`
          )
          .bind(r.uri, r.did, r.rkey, recordJson, nowUs, nowUs)
          .run();
        inserted += (result as { changes?: number })?.changes ?? 0;
      }
    }

    cursor = page.cursor ?? undefined;
    if (!cursor) break;
  }

  if (inserted > 0) {
    log.log(
      `[constellation] subject=${subjectDid} pages=${pages} inserted=${inserted}`
    );
  }
  return inserted;
}
