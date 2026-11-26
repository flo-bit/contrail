import type { Did } from "@atcute/lexicons";
import { parseResourceUri } from "@atcute/lexicons/syntax";
import type { ContrailConfig, Database, IngestEvent } from "./types";
import { recordsTableName, resolveCollectionKey } from "./types";
import { getPDS } from "./client";
import {
  MODERATION_ACTION_NSID,
  hasCountedRelations,
  parseModerationAction,
} from "./moderation";
import { createIngestEvent, ingestRecords } from "./ingest";
import { childRecountStatements } from "./db/records";
import { getDialect, isPostgresDialect } from "./dialect";
import { batchedInQuery } from "./router/helpers";
import { getLabelerState } from "./labels/subscribe";
import { applyLabels, type IncomingLabel } from "./labels/apply";

const MAX_RECONCILE_RECORDS = 1000;
const MAX_RECONCILE_PAGES = 10;

/** Best-effort PDS safety net for moderator actions (live changes arrive via
 * Jetstream and `notify`). Fetches up to 1,000 records per moderator and
 * ingests only diffs; missed deletions are retracted only when the full
 * listing completes cleanly without error or truncation. */
export async function reconcileModeratorActions(
  db: Database,
  config: ContrailConfig,
  deadline = Date.now() + 10_000,
): Promise<void> {
  const moderators = config.moderation?.moderators ?? [];
  if (!moderators.length || Date.now() >= deadline) return;
  const table = recordsTableName(
    resolveCollectionKey(config, MODERATION_ACTION_NSID) ?? "moderationAction",
  );
  const log = config.logger ?? console;
  for (const did of moderators) {
    if (Date.now() >= deadline) {
      log.warn(`[moderation] reconcile hit deadline before ${did}; remaining moderators skipped`);
      break;
    }
    try {
      const timeUs = Date.now() * 1000;
      const pds = await getPDS(
        did as Did,
        db,
        config,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      );
      if (!pds) continue;
      const records = new Map<
        string,
        { uri: string; cid: string; value: unknown }
      >();
      let cursor: string | undefined;
      const cursors = new Set<string>();
      let pages = 0;
      let complete = true;
      let truncatedReason: "cap" | "deadline" | null = null;
      do {
        if (Date.now() >= deadline) {
          complete = false;
          truncatedReason = "deadline";
          break;
        }
        if (records.size >= MAX_RECONCILE_RECORDS || pages >= MAX_RECONCILE_PAGES) {
          complete = false;
          truncatedReason = "cap";
          break;
        }
        pages++;
        const url = new URL("/xrpc/com.atproto.repo.listRecords", pds);
        url.searchParams.set("repo", did);
        url.searchParams.set("collection", MODERATION_ACTION_NSID);
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("cursor", cursor);
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
          if (!response.ok) {
            throw new Error(`Moderator listing HTTP ${response.status}`);
          }
          const data = (await response.json()) as {
            records?: Array<{ uri: string; cid: string; value: unknown }>;
            cursor?: string;
          };
          if (!Array.isArray(data?.records) || data.records.length > 100)
            throw new Error("Invalid moderator listing");
          for (const r of data.records) {
            if (
              !r ||
              typeof r.uri !== "string" ||
              !r.uri.startsWith(`at://${did}/${MODERATION_ACTION_NSID}/`) ||
              !r.cid ||
              !r.value
            )
              throw new Error("Invalid moderator record");
          }
          if (
            data.cursor !== undefined &&
            (typeof data.cursor !== "string" ||
              !data.cursor ||
              cursors.has(data.cursor))
          ) {
            throw new Error("Invalid moderator cursor");
          }
          for (const r of data.records) records.set(r.uri, r);
          cursor = data.cursor;
          if (cursor) cursors.add(cursor);
        } catch (error) {
          complete = false;
          log.warn(
            `[moderation] reconcile ${did} page failed: ${error}`,
          );
          break;
        }
      } while (cursor);
      if (truncatedReason === "cap") {
        log.warn(
          `[moderation] reconcile ${did} hit the ${MAX_RECONCILE_RECORDS}-record / ${MAX_RECONCILE_PAGES}-page cap ` +
            `(${records.size} records listed); remaining actions and deletion checks skipped`,
        );
      } else if (truncatedReason === "deadline") {
        log.warn(
          `[moderation] reconcile ${did} hit deadline after ${records.size} records; deletion checks skipped`,
        );
      }

      const local = new Map(
        (
          await batchedInQuery<{ uri: string; cid: string | null }>(
            db,
            `SELECT uri, cid FROM ${table} WHERE did = ? AND uri IN (__IN__)`,
            [did],
            [...records.keys()],
          )
        ).map((r) => [r.uri, r.cid]),
      );
      const events: IngestEvent[] = [];
      for (const r of records.values()) {
        if (local.get(r.uri) === r.cid) continue;
        if (!parseModerationAction(r.value) && !local.has(r.uri)) continue;
        events.push(
          createIngestEvent({
            did,
            collection: MODERATION_ACTION_NSID,
            rkey: r.uri.split("/").at(-1)!,
            uri: r.uri,
            cid: r.cid,
            value: r.value,
            operation: "update",
            timeUs,
            source: { id: "pds-moderation", time_us: timeUs },
          }),
        );
      }
      const deletionBudget = MAX_RECONCILE_RECORDS - events.length;
      if (complete && deletionBudget > 0) {
        const listedUris = isPostgresDialect(getDialect(db))
          ? "SELECT jsonb_array_elements_text(CAST(? AS jsonb))"
          : "SELECT value FROM json_each(?)";
        const missing = await db
          .prepare(
            `SELECT uri FROM ${table} WHERE did = ?
              AND uri NOT IN (${listedUris}) LIMIT ?`,
          )
          .bind(did, JSON.stringify([...records.keys()]), deletionBudget)
          .all<{ uri: string }>();
        for (const { uri } of missing.results)
          events.push(
            createIngestEvent({
              did,
              collection: MODERATION_ACTION_NSID,
              rkey: uri.split("/").at(-1)!,
              uri,
              operation: "delete",
              timeUs,
              source: { id: "pds-moderation", time_us: timeUs },
            }),
          );
      }
      if (events.length) await ingestRecords(db, events, config);
    } catch (error) {
      (config.logger ?? console).warn(
        `[moderation] reconcile ${did} failed: ${error}`,
      );
    }
  }
}

interface LabelBackfillRow {
  src: string;
  did: string;
  cursor: string | null;
  retries: number;
  generation: number;
}

/** One queryLabels page per queue item, fetched with bounded concurrency
 * under a fixed item/time budget. Cursor + labels commit together. Failed
 * pages retain progress and back off. Returns the number of items attempted. */
export async function runLabelBackfillQueue(
  db: Database,
  config: ContrailConfig,
  deadline = Date.now() + 10_000,
  maxItems = 100,
  concurrency = 8,
): Promise<number> {
  const sources = new Map(
    (config.labels?.sources ?? [])
      .filter((s) => s.subjects === "known" && !s.records)
      .map((s) => [s.did, s]),
  );
  if (!sources.size) return 0;
  const rows = await db
    .prepare(
      `SELECT src, did, cursor, retries, generation FROM label_backfill_queue
    WHERE completed = 0 AND next_attempt_at <= ? AND src IN (${[...sources].map(() => "?").join(",")})
    ORDER BY next_attempt_at, src, did LIMIT ?`,
    )
    .bind(Date.now(), ...sources.keys(), maxItems)
    .all<LabelBackfillRow>();
  const queue = [...rows.results];
  let attempted = 0;
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      if (Date.now() >= deadline) return;
      attempted++;
      await backfillOne(db, config, sources.get(row.src)!, row, deadline);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  return attempted;
}

async function backfillOne(
  db: Database,
  config: ContrailConfig,
  source: NonNullable<ContrailConfig["labels"]>["sources"][number],
  row: LabelBackfillRow,
  deadline: number,
): Promise<void> {
  const queueGuard = "src = ? AND did = ? AND generation = ? AND completed = 0";
  const guardArgs = [row.src, row.did, row.generation];
  let resetCursor = false;
  try {
    const state = await getLabelerState(db, row.src, source.endpoint, {
      ...config.networkOverrides,
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!state?.endpoint) throw new Error("Labeler unavailable");
    const url = new URL("/xrpc/com.atproto.label.queryLabels", state.endpoint);
    url.searchParams.append("uriPatterns", row.did);
    url.searchParams.append("uriPatterns", `at://${row.did}/*`);
    url.searchParams.append("sources", row.src);
    url.searchParams.set("limit", "100");
    if (row.cursor) url.searchParams.set("cursor", row.cursor);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) {
      // A rejected historical checkpoint cannot recover by retrying it. Only
      // restart for an explicit invalid-cursor error; transient failures and
      // unrelated bad requests must retain the last successful position.
      if (row.cursor && response.status === 400) {
        const failure = await response.json().catch(() => null) as { error?: string } | null;
        resetCursor = failure?.error === "InvalidCursor";
      }
      throw new Error(`queryLabels HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      labels?: IncomingLabel[];
      cursor?: string;
    };
    if (
      !Array.isArray(data.labels) ||
      data.labels.length > 100 ||
      (data.cursor !== undefined &&
        (typeof data.cursor !== "string" || data.cursor === row.cursor))
    )
      throw new Error("Invalid queryLabels page");
    // queryLabels must not smuggle unrelated subjects through known admission.
    const labels = data.labels.filter(
      (l) =>
        l &&
        typeof l.uri === "string" &&
        (l.uri === row.did || l.uri.startsWith(`at://${row.did}/`)),
    );
    await applyLabels(db, labels, {
      source,
      config,
      knownDids: new Set([row.did]),
      trailingStatements: [
        db
          .prepare(
            `UPDATE label_backfill_queue SET cursor = ?, completed = ?, retries = 0, next_attempt_at = 0,
              generation = generation + 1 WHERE ${queueGuard}`,
          )
          .bind(data.cursor ?? null, data.cursor ? 0 : 1, ...guardArgs),
      ],
    });
  } catch (error) {
    await db
      .prepare(
        `UPDATE label_backfill_queue SET cursor = CASE WHEN CAST(? AS INTEGER) = 1 THEN NULL ELSE cursor END,
          retries = retries + 1, next_attempt_at = ?, generation = generation + 1 WHERE ${queueGuard}`,
      )
      .bind(
        resetCursor ? 1 : 0,
        Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.retries, 7)),
        ...guardArgs,
      )
      .run();
    (config.logger ?? console).warn(
      `[labels] first-seen backfill ${row.did} failed: ${error}`,
    );
  }
}

const RECOUNT_PAGE = 100;

/** Drain due relation recounts caused by visibility changes. A DID subject
 * pages through its child records per collection; each page's recounts and
 * the queue cursor commit together. A re-enqueue resets the cursor, and the
 * guarded cursor update then restarts the subject from the first page. */
export async function runModerationRecounts(
  db: Database,
  config: ContrailConfig,
  deadline = Date.now() + 10_000,
  maxPages = 50,
): Promise<number> {
  const childShorts = [
    ...new Set(
      Object.values(config.collections).flatMap((c) =>
        Object.values(c.relations ?? {})
          .filter((r) => r.count !== false)
          .map((r) => r.collection),
      ),
    ),
  ];
  if (!childShorts.length) {
    // Rows can only remain from an older config with counted relations. Read
    // first: an unconditional DELETE would be a write on every tick.
    if (await db.prepare("SELECT 1 FROM moderation_recount_queue LIMIT 1").first())
      await db.prepare("DELETE FROM moderation_recount_queue").run();
    return 0;
  }
  const rows = await db
    .prepare(
      `SELECT subject, due_at, cursor FROM moderation_recount_queue
      WHERE due_at <= ? ORDER BY due_at, subject LIMIT ?`,
    )
    .bind(Math.floor(Date.now() / 1000), maxPages)
    .all<{ subject: string; due_at: number; cursor: string | null }>();
  let pages = 0;
  for (const row of rows.results) {
    let cursor = row.cursor;
    while (pages < maxPages && Date.now() < deadline) {
      pages++;
      const guard = `subject = ? AND due_at = ? AND COALESCE(cursor, '') = ?`;
      const guardArgs = [row.subject, Number(row.due_at), cursor ?? ""];
      let childShort: string | undefined;
      let records: Array<{ uri: string; record: unknown }> = [];
      let next: string | null = null;
      if (row.subject.startsWith("at://")) {
        const collection = parseResourceUri(row.subject).collection;
        const key = collection && resolveCollectionKey(config, collection);
        if (key && childShorts.includes(key)) {
          childShort = key;
          records = (
            await db
              .prepare(`SELECT uri, record FROM ${recordsTableName(key)} WHERE uri = ?`)
              .bind(row.subject)
              .all<{ uri: string; record: unknown }>()
          ).results;
        }
      } else {
        const position = cursor
          ? (JSON.parse(cursor) as [number, string])
          : ([0, ""] as [number, string]);
        childShort = childShorts[position[0]];
        if (childShort) {
          records = (
            await db
              .prepare(
                `SELECT uri, record FROM ${recordsTableName(childShort)}
                WHERE did = ? AND uri > ? ORDER BY uri LIMIT ?`,
              )
              .bind(row.subject, position[1], RECOUNT_PAGE)
              .all<{ uri: string; record: unknown }>()
          ).results;
          if (records.length === RECOUNT_PAGE)
            next = JSON.stringify([position[0], records.at(-1)!.uri]);
          else if (position[0] + 1 < childShorts.length)
            next = JSON.stringify([position[0] + 1, ""]);
        }
      }
      await db.batch([
        ...(childShort
          ? childRecountStatements(db, config, childShort, records)
          : []),
        next
          ? db
              .prepare(`UPDATE moderation_recount_queue SET cursor = ? WHERE ${guard}`)
              .bind(next, ...guardArgs)
          : db
              .prepare(`DELETE FROM moderation_recount_queue WHERE ${guard}`)
              .bind(...guardArgs),
      ]);
      // Re-read: a concurrent re-enqueue may have reset or replaced the row.
      const current = await db
        .prepare(
          "SELECT cursor FROM moderation_recount_queue WHERE subject = ? AND due_at = ?",
        )
        .bind(row.subject, Number(row.due_at))
        .first<{ cursor: string | null }>();
      if (!current) break;
      cursor = current.cursor;
    }
    if (pages >= maxPages || Date.now() >= deadline) break;
  }
  return pages;
}

/** Whether this config can have any background moderation work (moderator
 * action reconciliation, first-seen label backfill, or visibility recounts). */
export function needsModerationCycle(config: ContrailConfig): boolean {
  const hasModerators = (config.moderation?.moderators.length ?? 0) > 0;
  const hasKnownLabelSources = (config.labels?.sources ?? []).some(
    (s) => s.subjects === "known" && !s.records,
  );
  return hasModerators || hasKnownLabelSources || hasCountedRelations(config);
}

/** Bounded moderation maintenance for one scheduled tick: moderator action
 * reconciliation, first-seen label backfill, and visibility recounts. */
export async function runModerationCycle(
  db: Database,
  config: ContrailConfig,
  deadline = Date.now() + 10_000,
  options: { reconcile?: boolean } = {},
): Promise<{ backfilled: number; recountPages: number }> {
  const log = config.logger ?? console;
  const step = (ms: number) => Math.min(deadline, Date.now() + ms);
  if (options.reconcile !== false)
    await reconcileModeratorActions(db, config, step(3_000));
  let backfilled = 0;
  let recountPages = 0;
  try {
    backfilled = await runLabelBackfillQueue(db, config, step(5_000));
  } catch (error) {
    log.warn(`[labels] first-seen backfill cycle failed: ${error}`);
  }
  try {
    recountPages = await runModerationRecounts(db, config, deadline);
  } catch (error) {
    log.warn(`[moderation] recount cycle failed: ${error}`);
  }
  return { backfilled, recountPages };
}

/** Long-lived equivalent of `runModerationCycle`. Loops immediately while
 * queued work remains, otherwise waits `idleMs` between reconciles. */
export async function runPersistentModeration(
  db: Database,
  config: ContrailConfig,
  options: { signal?: AbortSignal; idleMs?: number } = {},
): Promise<void> {
  const { signal } = options;
  const idleMs = options.idleMs ?? 30_000;
  let lastReconcile = 0;
  while (!signal?.aborted) {
    const reconcile = Date.now() - lastReconcile >= idleMs;
    if (reconcile) lastReconcile = Date.now();
    const { backfilled, recountPages } = await runModerationCycle(
      db,
      config,
      Date.now() + 10_000,
      { reconcile },
    );
    if (backfilled || recountPages) continue;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, idleMs);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}
