import type { ContrailConfig, Database } from "./types";
import { recordsTableName } from "./types";
import { getDialect, sqliteFtsContentExpression } from "./dialect";
import {
  ftsRowTableName,
  ftsTableName,
  getSearchableFields,
} from "./search";

export const BOOTSTRAP_VERIFICATION_META_KEY = "bootstrap_verification";

export interface BootstrapVerificationCheck {
  name: string;
  ok: boolean;
  failures: number;
}

export interface BootstrapVerificationReport {
  ok: boolean;
  verifiedAt: number;
  checks: BootstrapVerificationCheck[];
}

export class BootstrapVerificationError extends Error {
  constructor(readonly report: BootstrapVerificationReport) {
    const failed = report.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}=${check.failures}`)
      .join(", ");
    super(`Bootstrap candidate verification failed: ${failed}`);
    this.name = "BootstrapVerificationError";
  }
}

async function count(db: Database, sql: string, bindings: unknown[] = []) {
  const row = await db
    .prepare(sql)
    .bind(...bindings)
    .first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

function check(name: string, failures: number): BootstrapVerificationCheck {
  return { name, ok: failures === 0, failures };
}

/** Aggregate-only integrity checks for an unpublished candidate database. */
export async function verifyBootstrapCandidate(
  db: Database,
  config: ContrailConfig,
): Promise<BootstrapVerificationReport> {
  const checks: BootstrapVerificationCheck[] = [];
  checks.push(
    check(
      "snapshot-partitions",
      await count(
        db,
        "SELECT COUNT(*) AS count FROM bootstrap_snapshot_progress WHERE completed = 0",
      ),
    ),
  );

  for (const [shortName, collectionConfig] of Object.entries(
    config.collections,
  )) {
    const collection = collectionConfig.collection ?? shortName;
    const table = recordsTableName(shortName);
    checks.push(
      check(
        `visible-version:${shortName}`,
        await count(
          db,
          `SELECT COUNT(*) AS count FROM ${table} AS record
           LEFT JOIN record_versions AS version ON version.uri = record.uri
           WHERE version.uri IS NULL OR version.operation = 'delete'
             OR version.collection <> ? OR version.did <> record.did
             OR version.rkey <> record.rkey`,
          [collection],
        ),
      ),
    );
    checks.push(
      check(
        `version-visible:${shortName}`,
        await count(
          db,
          `SELECT COUNT(*) AS count FROM record_versions AS version
           LEFT JOIN ${table} AS record ON record.uri = version.uri
           WHERE version.collection = ? AND version.operation <> 'delete'
             AND record.uri IS NULL`,
          [collection],
        ),
      ),
    );

    const fields = getSearchableFields(shortName, collectionConfig);
    if (getDialect(db).ftsStrategy === "virtual-table" && fields) {
      const ftsTable = ftsTableName(shortName);
      const rowsTable = ftsRowTableName(shortName);
      const tables = await count(
        db,
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        [ftsTable, rowsTable],
      );
      checks.push(check(`fts-tables:${shortName}`, Math.max(0, 2 - tables)));
      if (tables === 2) {
        const content = sqliteFtsContentExpression(fields);
        const expected = await count(
          db,
          `SELECT COUNT(*) AS count FROM (
             SELECT ${content} AS content FROM ${table}
           ) searchable WHERE content <> ''`,
        );
        const mapping = await count(
          db,
          `SELECT COUNT(*) AS count FROM ${rowsTable}`,
        );
        const fts = await count(db, `SELECT COUNT(*) AS count FROM ${ftsTable}`);
        const joined = await count(
          db,
          `SELECT COUNT(*) AS count
           FROM ${rowsTable} mapped
           JOIN ${ftsTable} fts ON fts.rowid = mapped.id
           JOIN (
             SELECT uri FROM (
               SELECT uri, ${content} AS content FROM ${table}
             ) searchable
             WHERE content <> ''
           ) expected ON expected.uri = mapped.uri`,
        );
        checks.push(
          check(`fts-mapping:${shortName}`, Math.abs(expected - mapping)),
          check(`fts-rows:${shortName}`, Math.abs(expected - fts)),
          check(`fts-joined:${shortName}`, Math.abs(expected - joined)),
        );
      }
    }
  }

  return {
    ok: checks.every((item) => item.ok),
    verifiedAt: Date.now(),
    checks,
  };
}

export async function getBootstrapVerification(
  db: Database,
): Promise<BootstrapVerificationReport | null> {
  const row = await db
    .prepare("SELECT value FROM _contrail_meta WHERE key = ?")
    .bind(BOOTSTRAP_VERIFICATION_META_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    throw new Error("Durable bootstrap verification is not valid JSON");
  }
  const report = value as BootstrapVerificationReport;
  if (
    !value ||
    typeof value !== "object" ||
    typeof report.ok !== "boolean" ||
    !Number.isSafeInteger(report.verifiedAt) ||
    report.verifiedAt < 0 ||
    !Array.isArray(report.checks) ||
    !report.checks.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.name === "string" &&
        typeof item.ok === "boolean" &&
        Number.isSafeInteger(item.failures) &&
        item.failures >= 0,
    )
  ) {
    throw new Error("Durable bootstrap verification is malformed");
  }
  return report;
}
