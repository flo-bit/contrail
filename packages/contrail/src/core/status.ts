import type { ContrailConfig, Database } from "./types";
import { DEFAULT_RELAYS, getDiscoverableNsids } from "./types";

interface AggregateRow {
  total: number | string | null;
  complete: number | string | null;
  pending: number | string | null;
  failed: number | string | null;
}

export interface BackfillCounts {
  total: number;
  complete: number;
  pending: number;
  failed: number;
}

export interface BackfillAccountCounts {
  total: number;
  complete: number;
  pending: number;
  unreachable: number;
}

export interface BackfillCollectionStatus extends BackfillCounts {
  collection: string;
}

export interface BackfillStatus {
  state: "not_started" | "incomplete" | "complete";
  known_progress_percent: number;
  accounts: BackfillAccountCounts;
  tasks: BackfillCounts;
  discovery: BackfillCounts;
  collections: BackfillCollectionStatus[];
}

function number(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function counts(row: AggregateRow | null): BackfillCounts {
  return {
    total: number(row?.total),
    complete: number(row?.complete),
    pending: number(row?.pending),
    failed: number(row?.failed)
  };
}

export async function getBackfillStatus(
  db: Database,
  config?: ContrailConfig
): Promise<BackfillStatus> {
  const [taskRow, accountRow, discoveryRow, collectionRows] = await Promise.all([
    db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS complete,
          COALESCE(SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN completed = 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed
        FROM backfills`
      )
      .first<AggregateRow>(),
    db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS complete,
          COALESCE(SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN completed = 0 AND unreachable = 1 THEN 1 ELSE 0 END), 0) AS failed
        FROM (
          SELECT
            did,
            MIN(completed) AS completed,
            MAX(CASE WHEN completed = 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END) AS unreachable
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
          COALESCE(SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN completed = 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed
        FROM discovery`
      )
      .first<AggregateRow>(),
    db
      .prepare(
        `SELECT
          collection,
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS complete,
          COALESCE(SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN completed = 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed
        FROM backfills
        GROUP BY collection
        ORDER BY collection`
      )
      .all<AggregateRow & { collection: string }>()
  ]);

  const tasks = counts(taskRow);
  const discovery = counts(discoveryRow);
  const accountCounts = counts(accountRow);
  const accounts: BackfillAccountCounts = {
    total: accountCounts.total,
    complete: accountCounts.complete,
    pending: accountCounts.pending,
    unreachable: accountCounts.failed
  };
  const collections = (collectionRows.results ?? []).map((row) => ({
    collection: row.collection,
    ...counts(row)
  }));

  const expectsDiscovery = config
    ? getDiscoverableNsids(config).length > 0 &&
      (config.relays ?? DEFAULT_RELAYS).length > 0
    : true;
  const state =
    tasks.total === 0 && discovery.total === 0
      ? expectsDiscovery
        ? "not_started"
        : "complete"
      : tasks.pending === 0 && discovery.pending === 0
        ? "complete"
        : "incomplete";
  const knownProgressPercent =
    tasks.total === 0 ? (state === "complete" ? 100 : 0) : Math.floor((tasks.complete / tasks.total) * 10_000) / 100;

  return {
    state,
    known_progress_percent: knownProgressPercent,
    accounts,
    tasks,
    discovery,
    collections
  };
}
