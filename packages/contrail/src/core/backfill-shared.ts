/** Helpers shared between the listRecords-based and CAR-based backfill paths. */
import { isDid } from "@atcute/lexicons/syntax";

import type { ContrailConfig, Database, IngestEvent } from "./types";
import { shortNameForNsid } from "./types";

const DEFAULT_TIME_FIELD = "createdAt";

/** Parse the record's canonical time (e.g. createdAt) and return microseconds.
 *  Falls back to `nowUs` when missing/invalid. Clamps to nowUs to avoid
 *  user-controlled future timestamps pinning records at the top of feeds. */
export function recordTimeUs(
  record: unknown,
  collection: string,
  config: ContrailConfig | undefined,
  nowUs: number
): number {
  if (!config) return nowUs;
  const short = shortNameForNsid(config, collection);
  const colCfg = short ? config.collections[short] : undefined;
  const field = colCfg?.timeField ?? DEFAULT_TIME_FIELD;
  if (field === false) return nowUs;
  const raw =
    record && typeof record === "object"
      ? (record as Record<string, unknown>)[field]
      : undefined;
  if (typeof raw !== "string") return nowUs;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms <= 0) return nowUs;
  const us = ms * 1000;
  return us > nowUs ? nowUs : us;
}

/** Drop events whose `subjectField` value is a DID we have no identity for.
 *  One bulk SELECT per call, suitable for use after each backfill batch. */
export async function filterEventsBySubject(
  db: Database,
  events: IngestEvent[],
  subjectField: string
): Promise<IngestEvent[]> {
  const subjects = new Set<string>();
  const eventSubjects = new Map<string, string>();
  for (const e of events) {
    if (!e.record) continue;
    let subj: unknown;
    try {
      subj = JSON.parse(e.record)?.[subjectField];
    } catch {
      continue;
    }
    if (typeof subj === "string" && isDid(subj)) {
      subjects.add(subj);
      eventSubjects.set(e.uri, subj);
    }
  }
  if (subjects.size === 0) return [];

  const known = new Set<string>();
  const list = [...subjects];
  const CHUNK = 100;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT did FROM identities WHERE did IN (${placeholders})`)
      .bind(...chunk)
      .all<{ did: string }>();
    for (const r of rows.results ?? []) known.add(r.did);
  }

  return events.filter((e) => {
    const subj = eventSubjects.get(e.uri);
    return subj !== undefined && known.has(subj);
  });
}
