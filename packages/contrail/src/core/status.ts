import type { ContrailConfig, Database } from "./types";
import { DEFAULT_RELAYS, getDiscoverableNsids } from "./types";

interface AggregateRow {
  total: number | string | null;
  complete: number | string | null;
  pending: number | string | null;
  retrying: number | string | null;
  failed: number | string | null;
}

export interface BackfillAccountCounts {
  total: number;
  complete: number;
  pending: number;
  retrying: number;
  failed: number;
}

export interface BackfillCollectionStatus extends BackfillAccountCounts {
  collection: string;
}

export interface BackfillRetryStatus {
  scheduled_accounts: number;
  due_accounts: number;
  next_retry_at: number | null;
  next_retry_date: string | null;
}

export interface BackfillStatus {
  state: "not_started" | "running" | "incomplete" | "complete";
  known_progress_percent: number;
  accounts: BackfillAccountCounts;
  discovery: BackfillAccountCounts;
  retries: BackfillRetryStatus;
  collections: BackfillCollectionStatus[];
}

function number(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function counts(row: AggregateRow | null): BackfillAccountCounts {
  return {
    total: number(row?.total),
    complete: number(row?.complete),
    pending: number(row?.pending),
    retrying: number(row?.retrying),
    failed: number(row?.failed)
  };
}

const BACKFILL_RUN_STALE_MS = 2 * 60_000;

function createRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function tryStartBackfillRun(
  db: Database
): Promise<string | null> {
  const runId = createRunId();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO backfill_state (id, run_id, started_at, heartbeat_at, finished_at) VALUES (1, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at, finished_at = NULL WHERE backfill_state.finished_at IS NOT NULL OR backfill_state.heartbeat_at IS NULL OR backfill_state.heartbeat_at < ?"
    )
    .bind(runId, now, now, now - BACKFILL_RUN_STALE_MS)
    .run();
  const row = await db
    .prepare("SELECT run_id FROM backfill_state WHERE id = 1")
    .first<{ run_id: string | null }>();
  return row?.run_id === runId ? runId : null;
}

export async function heartbeatBackfillRun(
  db: Database,
  runId: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE backfill_state SET heartbeat_at = ? WHERE id = 1 AND run_id = ? AND finished_at IS NULL"
    )
    .bind(Date.now(), runId)
    .run();
}

export async function finishBackfillRun(
  db: Database,
  runId: string
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      "UPDATE backfill_state SET heartbeat_at = ?, finished_at = ? WHERE id = 1 AND run_id = ?"
    )
    .bind(now, now, runId)
    .run();
}

export async function getBackfillStatus(
  db: Database,
  config?: ContrailConfig
): Promise<BackfillStatus> {
  const now = Date.now();
  const [
    taskRow,
    accountRow,
    discoveryRow,
    collectionRows,
    retryRow,
    runRow,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS complete,
          COALESCE(SUM(CASE WHEN completed = 0 AND retry_exhausted = 0 AND last_error IS NULL THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN completed = 0 AND retry_exhausted = 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS retrying,
          COALESCE(SUM(CASE WHEN completed = 0 AND retry_exhausted = 1 THEN 1 ELSE 0 END), 0) AS failed
        FROM backfills`
      )
      .first<AggregateRow>(),
    db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS complete,
          COALESCE(SUM(CASE WHEN completed = 0 AND has_retrying = 0 AND has_failed = 0 THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN completed = 0 AND (has_retrying = 1 OR (has_failed = 1 AND has_pending = 1)) THEN 1 ELSE 0 END), 0) AS retrying,
          COALESCE(SUM(CASE WHEN completed = 0 AND has_failed = 1 AND has_pending = 0 AND has_retrying = 0 THEN 1 ELSE 0 END), 0) AS failed
        FROM (
          SELECT
            did,
            MIN(completed) AS completed,
            MAX(CASE WHEN completed = 0 AND retry_exhausted = 0 AND last_error IS NULL THEN 1 ELSE 0 END) AS has_pending,
            MAX(CASE WHEN completed = 0 AND retry_exhausted = 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END) AS has_retrying,
            MAX(CASE WHEN completed = 0 AND retry_exhausted = 1 THEN 1 ELSE 0 END) AS has_failed
          FROM backfills
          GROUP BY did
        ) AS accounts`
      )
      .first<AggregateRow>(),
    db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS complete,
          COALESCE(SUM(CASE WHEN completed = 0 AND last_error IS NULL THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN completed = 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS retrying,
          0 AS failed
        FROM discovery`
      )
      .first<AggregateRow>(),
    db
      .prepare(
        `SELECT
          collection,
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS complete,
          COALESCE(SUM(CASE WHEN completed = 0 AND retry_exhausted = 0 AND last_error IS NULL THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN completed = 0 AND retry_exhausted = 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS retrying,
          COALESCE(SUM(CASE WHEN completed = 0 AND retry_exhausted = 1 THEN 1 ELSE 0 END), 0) AS failed
        FROM backfills
        GROUP BY collection
        ORDER BY collection`
      )
      .all<AggregateRow & { collection: string }>(),
    db
      .prepare(
        `SELECT
          COUNT(*) AS scheduled_accounts,
          COALESCE(SUM(CASE WHEN next_retry_at IS NULL OR next_retry_at <= ? THEN 1 ELSE 0 END), 0) AS due_accounts,
          MIN(next_retry_at) AS next_retry_at
        FROM (
          SELECT did, MIN(next_retry_at) AS next_retry_at
          FROM backfills
          WHERE completed = 0 AND retry_exhausted = 0 AND last_error IS NOT NULL
          GROUP BY did
        ) AS retry_accounts`
      )
      .bind(now)
      .first<{
        scheduled_accounts: number | string | null;
        due_accounts: number | string | null;
        next_retry_at: number | string | null;
      }>(),
    db
      .prepare(
        "SELECT run_id, heartbeat_at, finished_at FROM backfill_state WHERE id = 1"
      )
      .first<{
        run_id: string | null;
        heartbeat_at: number | null;
        finished_at: number | null;
      }>()
  ]);

  const taskCounts = counts(taskRow);
  const accounts = counts(accountRow);
  const discovery = counts(discoveryRow);
  const collections = (collectionRows.results ?? []).map((row) => ({
    collection: row.collection,
    ...counts(row)
  }));

  const scheduledAccounts = number(retryRow?.scheduled_accounts);
  const dueAccounts = number(retryRow?.due_accounts);
  const nextRetryValue = retryRow?.next_retry_at;
  const nextRetryAt =
    dueAccounts > 0 ||
    nextRetryValue === null ||
    nextRetryValue === undefined
      ? null
      : number(nextRetryValue);
  const retries: BackfillRetryStatus = {
    scheduled_accounts: scheduledAccounts,
    due_accounts: dueAccounts,
    next_retry_at: nextRetryAt,
    next_retry_date: nextRetryAt ? new Date(nextRetryAt).toISOString() : null
  };

  const expectsDiscovery = config
    ? getDiscoverableNsids(config).length > 0 &&
      (config.relays ?? DEFAULT_RELAYS).length > 0
    : true;
  const running =
    !!runRow?.run_id &&
    runRow.finished_at === null &&
    number(runRow.heartbeat_at) >= now - BACKFILL_RUN_STALE_MS;
  const state = running
    ? "running"
    : taskCounts.total === 0 && discovery.total === 0
      ? expectsDiscovery
        ? "not_started"
        : "complete"
      : discovery.complete < discovery.total || taskCounts.pending > 0
        ? "incomplete"
        : "complete";
  const knownProgressPercent =
    accounts.total === 0
      ? state === "complete"
        ? 100
        : 0
      : Math.floor((accounts.complete / accounts.total) * 10_000) / 100;

  return {
    state,
    known_progress_percent: knownProgressPercent,
    accounts,
    discovery,
    retries,
    collections
  };
}
