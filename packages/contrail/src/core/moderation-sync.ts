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
import { getMeta, setMeta } from "./db/meta";
import { getDialect, isPostgresDialect } from "./dialect";
import { batchedInQuery } from "./router/helpers";
import { getLabelerState } from "./labels/resolve";
import { applyLabels, type IncomingLabel } from "./labels/apply";

const LAST_RECONCILED_MODERATOR_KEY = "moderation_last_attempted_moderator";
/** Per-moderator listRecords cursor of a sweep paused by its budget. */
const RECONCILE_CURSOR_PREFIX = "moderation_reconcile_cursor:";
const MAX_RECONCILE_RECORDS = 1000;
const MAX_RECONCILE_PAGES = 10;

/** Missed deletions are retracted only from a COMPLETE listing fetched within
 * one cycle. A partial page, timeout or malformed response never retracts
 * local actions. Pagination and work per cycle are bounded: a listing that
 * exceeds the budget applies the creates/updates seen so far and resumes from
 * a durable cursor next cycle, so large repos still converge on changes (their
 * deletions rely on live ingestion and fail closed). Local lookups are bounded
 * too, and inferred deletions share the 1000-mutation budget with updates.
 * A large local deletion backlog drains over repeated complete fresh listings.
 * Persist the last attempt
 * so timeouts cannot starve later moderators, even across scheduled
 * invocations in different Worker isolates. */
export async function reconcileModeratorActions(
  db: Database,
  config: ContrailConfig,
  deadline = Date.now() + 10_000,
): Promise<void> {
  const moderators = config.moderation?.moderators ?? [];
  if (!moderators.length || Date.now() >= deadline) return;
  const last = moderators.length > 1
    ? await getMeta(db, LAST_RECONCILED_MODERATOR_KEY)
    : null;
  const start = (moderators.indexOf(last ?? "") + 1) % moderators.length;
  for (let offset = 0; offset < moderators.length; offset++) {
    if (Date.now() >= deadline) break;
    const did = moderators[(start + offset) % moderators.length]!;
    // Advance before network I/O so failed/interrupted listings rotate too.
    // A single moderator needs no scheduling metadata writes.
    if (moderators.length > 1)
      await setMeta(db, LAST_RECONCILED_MODERATOR_KEY, did);
    const cursorKey = `${RECONCILE_CURSOR_PREFIX}${did}`;
    let resumed: string | undefined;
    try {
      resumed = (await getMeta(db, cursorKey)) ?? undefined;
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
      let cursor = resumed;
      const cursors = new Set<string>(resumed ? [resumed] : []);
      let pages = 0;
      let paused = false;
      let resetCursor = false;
      do {
        if (
          Date.now() >= deadline ||
          records.size >= MAX_RECONCILE_RECORDS ||
          pages >= MAX_RECONCILE_PAGES
        ) {
          paused = true;
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
            // A rejected cursor may be stale. Timeouts, rate limits and server
            // failures must keep the last successfully validated position.
            resetCursor = !!cursor && response.status === 400;
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
          if (data.cursor !== undefined &&
              (typeof data.cursor !== "string" || !data.cursor || cursors.has(data.cursor))) {
            resetCursor = true;
            throw new Error("Invalid moderator cursor");
          }
          // Accept only whole validated pages. In particular, a malformed
          // final page must never turn this into a complete deletion sweep.
          for (const r of data.records) records.set(r.uri, r);
          cursor = data.cursor;
          if (cursor) cursors.add(cursor);
        } catch (error) {
          paused = true;
          (config.logger ?? console).warn(
            `[moderation] reconcile ${did} page failed: ${error}`,
          );
          break;
        }
      } while (cursor);
      // Deletions can only be inferred from one complete, fresh listing.
      const complete = !paused && !resumed;
      if (paused && !resumed && records.size >= MAX_RECONCILE_RECORDS)
        (config.logger ?? console).warn(
          `[moderation] ${did} has more than ${MAX_RECONCILE_RECORDS} actions; reconciling across cycles. Missed deletions are only applied from live ingestion.`,
        );
      // Only send what differs from local state: unchanged actions cost no
      // writes, so a frequent reconcile stays cheap.
      const table = recordsTableName(
        resolveCollectionKey(config, MODERATION_ACTION_NSID) ??
          "moderationAction",
      );
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
        // Invalid remote actions are retracted by ingest; skip if absent.
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
        // The listing is a complete absence proof, but the local corpus may
        // be much larger than it. Fetch only this cycle's remaining budget.
        // No ORDER BY: the did index can stop after enough missing rows,
        // without sorting/scanning the entire moderator's local history.
        // A single JSON parameter keeps even a full listing below D1's bind
        // limit. A subsequent cycle obtains a fresh complete absence proof
        // before draining more; partial/resumed listings never undo actions.
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
      // The sweep position commits with the changes it covers.
      const progress =
        resetCursor
          ? [db.prepare("DELETE FROM _contrail_meta WHERE key = ? AND value = ?").bind(cursorKey, resumed ?? "")]
          : paused && cursor !== resumed
          ? [
              db
                .prepare(
                  "INSERT INTO _contrail_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(cursorKey, cursor),
            ]
          : !paused && resumed
            ? [db.prepare("DELETE FROM _contrail_meta WHERE key = ?").bind(cursorKey)]
            : [];
      // Validated pages and their cursor commit together, even when a later
      // page failed. Missed deletions still require a complete fresh listing.
      if (events.length)
        await ingestRecords(db, events, config, {
          trailingStatements: progress,
        });
      else if (progress.length) await db.batch(progress);
    } catch (error) {
      // Resolution/storage failures leave durable progress untouched. Only
      // an explicitly rejected or malformed pagination cursor resets a sweep.
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
