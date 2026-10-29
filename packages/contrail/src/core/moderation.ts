import { isCid, isDid, parseResourceUri } from "@atcute/lexicons/syntax";
import type {
  ContrailConfig,
  Database,
  IngestEvent,
  Statement,
} from "./types";
import { recordsTableName } from "./types";
import { getDialect, isPostgresDialect } from "./dialect";
import type { SqlDialect } from "./dialect";
import { batchedInQuery } from "./router/helpers";
import { MODERATION_ACTION_NSID } from "../moderation-contract";

export { MODERATION_ACTION_NSID };
export const BLUESKY_MODERATION_DID = "did:plc:ar7c4by46qjdydhdevvrndac";

export interface ModerationConfig {
  moderators: string[];
  /** Expose service-authenticated report XRPC routes (requires serviceAuth.audience).
   * Defaults to true. Set false for session-backed createModerationReports calls. */
  reports?: boolean;
}

export interface ModerationAction {
  subject: string;
  subjectCid?: string;
  action: string;
  labels?: string[];
  src?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface AccountUpdate {
  did: string;
  active: boolean;
  status?: string;
  timeUs: number;
  cursor: number;
}

/** Accept only canonical DID subjects and DID-authority record URIs. */
export function subjectDid(subject: string): string | null {
  if (isDid(subject)) return subject;
  try {
    const parsed = parseResourceUri(subject);
    return isDid(parsed.repo) &&
      parsed.collection &&
      parsed.rkey &&
      subject === `at://${parsed.repo}/${parsed.collection}/${parsed.rkey}`
      ? parsed.repo
      : null;
  } catch {
    return null;
  }
}

export function parseModerationAction(value: unknown): ModerationAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.$type !== undefined && r.$type !== MODERATION_ACTION_NSID) return null;
  // Public action records must never accidentally publish private evidence.
  const allowed = new Set([
    "$type",
    "subject",
    "subjectCid",
    "action",
    "labels",
    "src",
    "expiresAt",
    "createdAt",
  ]);
  if (Object.keys(r).some((key) => !allowed.has(key))) return null;
  if (
    typeof r.subject !== "string" ||
    !subjectDid(r.subject) ||
    typeof r.action !== "string" ||
    !/^(?:![a-z-]+|[a-z][a-z0-9-]*)$/.test(r.action) ||
    r.action.length > 128 ||
    typeof r.createdAt !== "string" ||
    !Number.isFinite(Date.parse(r.createdAt))
  )
    return null;
  if (
    r.subjectCid !== undefined &&
    (typeof r.subjectCid !== "string" ||
      r.subjectCid.length > 256 ||
      !isCid(r.subjectCid) ||
      !r.subject.startsWith("at://"))
  )
    return null;
  if (
    r.expiresAt !== undefined &&
    (typeof r.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(r.expiresAt)))
  )
    return null;
  if (r.src !== undefined && (typeof r.src !== "string" || !isDid(r.src)))
    return null;
  if (
    r.labels !== undefined &&
    (!Array.isArray(r.labels) ||
      !r.labels.length ||
      r.labels.length > 128 ||
      r.labels.some((v) => typeof v !== "string" || !v || v.length > 128))
  )
    return null;
  if (
    r.action !== "override" &&
    (r.src !== undefined || r.labels !== undefined)
  )
    return null;
  return r as unknown as ModerationAction;
}

export const HIDE_LABEL_VALUES = ["!hide", "!takedown"] as const;
const HIDDEN_ACCOUNT_STATUSES = ["deleted", "deactivated", "takendown", "suspended"];
export const HIDE_VALUES_SQL = HIDE_LABEL_VALUES.map((v) => `'${v}'`).join(", ");
const HIDDEN_ACCOUNT_SQL = `(active = 0 OR status IN (${HIDDEN_ACCOUNT_STATUSES.map((v) => `'${v}'`).join(", ")}))`;
/** Serializes PostgreSQL hidden-state recomputation (SQLite/D1 batches are
 * already serialized). */
const PG_MODERATION_LOCK = 0x6d6f64;

/** Acquire before queue-row locks as well as hidden-state writes, matching
 * action projection's moderation-lock -> enqueue order on PostgreSQL. */
export function moderationLockStatements(db: Database): Statement[] {
  return isPostgresDialect(getDialect(db))
    ? [db.prepare(`SELECT pg_advisory_xact_lock(${PG_MODERATION_LOCK})`)]
    : [];
}

/** SQL predicate evaluated inside the same write transaction as its writes. */
export interface ModerationWriteGuard {
  sql: string;
  bindings: unknown[];
}

export function buildModerationSchema(d: SqlDialect): string[] {
  const pg = isPostgresDialect(d);
  const effectiveLabels = `moderation_effective_labels AS
      SELECT l.* FROM labels l
      WHERE NOT EXISTS (SELECT 1 FROM moderation_sources s WHERE s.did = l.src AND s.moderator = 1)
      AND l.neg = 0 AND (l.exp IS NULL OR l.exp > ${nowSql(d)})
      AND NOT EXISTS (SELECT 1 FROM labels newer
        WHERE newer.src = l.src AND newer.uri = l.uri AND newer.val = l.val AND newer.cts > l.cts)
      AND NOT EXISTS (
        SELECT 1 FROM moderation_overrides o
        JOIN moderation_sources m ON m.did = o.moderator AND m.moderator = 1
        WHERE ${overrideSuppressesSql("o", "l")} AND (o.exp IS NULL OR o.exp > ${nowSql(d)})
      )
      UNION ALL
      SELECT a.src, a.subject, a.action, a.cid, 0, a.exp, a.cts, NULL
      FROM moderation_actions a
      JOIN moderation_sources s ON s.did = a.src AND s.moderator = 1
      WHERE a.exp IS NULL OR a.exp > ${nowSql(d)}`;
  return [
    `CREATE TABLE IF NOT EXISTS account_state (
      did TEXT PRIMARY KEY, active INTEGER NOT NULL, status TEXT,
      source TEXT NOT NULL, epoch TEXT, cursor ${d.bigintType} NOT NULL,
      time_us ${d.bigintType} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS moderation_sources (
      did TEXT PRIMARY KEY, moderator INTEGER NOT NULL, enforced INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS moderation_actions (
      uri TEXT PRIMARY KEY, src TEXT NOT NULL, subject TEXT NOT NULL,
      action TEXT NOT NULL, cid TEXT, exp ${d.bigintType}, cts ${d.bigintType} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moderation_actions_subject ON moderation_actions(subject)`,
    `CREATE TABLE IF NOT EXISTS moderation_overrides (
      uri TEXT NOT NULL, moderator TEXT NOT NULL, subject TEXT NOT NULL,
      src TEXT, val TEXT NOT NULL, cid TEXT, exp ${d.bigintType}, cts ${d.bigintType} NOT NULL,
      PRIMARY KEY (uri, val)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moderation_overrides_subject ON moderation_overrides(subject)`,
    // Materialized enforcement state. Rows are recomputed per subject in the
    // same transaction as the label/action/override/account change. Time
    // bounds are stored rather than swept: a row hides only while
    // starts_at <= now < exp (an expiring override delays starts_at).
    `CREATE TABLE IF NOT EXISTS moderation_hidden (
      subject TEXT NOT NULL, kind TEXT NOT NULL, cid TEXT NOT NULL DEFAULT '',
      starts_at ${d.bigintType}, exp ${d.bigintType}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moderation_hidden_subject ON moderation_hidden(subject)`,
    `CREATE TABLE IF NOT EXISTS moderation_dirty (
      token TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY (token, subject)
    )`,
    // Pre-recompute hidden rows of dirty subjects, cleared in the same batch.
    // Only subjects whose visibility actually changed are recounted.
    `CREATE TABLE IF NOT EXISTS moderation_hidden_snapshot (
      token TEXT NOT NULL, subject TEXT NOT NULL, cid TEXT NOT NULL,
      starts_at ${d.bigintType}, exp ${d.bigintType}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moderation_hidden_snapshot_token ON moderation_hidden_snapshot(token)`,
    // Stored relation counts exclude hidden children; visibility changes
    // (including future expiry boundaries) recount affected parents here.
    `CREATE TABLE IF NOT EXISTS moderation_recount_queue (
      subject TEXT NOT NULL, due_at ${d.bigintType} NOT NULL, cursor TEXT,
      PRIMARY KEY (subject, due_at)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moderation_recount_due ON moderation_recount_queue(due_at)`,
    ...(pg
      ? [`CREATE OR REPLACE VIEW ${effectiveLabels}`]
      : [
          // IF NOT EXISTS keeps concurrent initializers idempotent.
          "DROP VIEW IF EXISTS moderation_effective_labels",
          `CREATE VIEW IF NOT EXISTS ${effectiveLabels}`,
        ]),
    `CREATE TABLE IF NOT EXISTS label_backfill_sources (src TEXT PRIMARY KEY, policy TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS label_backfill_queue (
      src TEXT NOT NULL, did TEXT NOT NULL, cursor TEXT, completed INTEGER NOT NULL DEFAULT 0,
      retries INTEGER NOT NULL DEFAULT 0, next_attempt_at ${d.bigintType} NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (src, did)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_label_backfill_pending ON label_backfill_queue(completed, next_attempt_at)`,
    ...buildModerationReportsSchema(d),
  ];
}

/** An override pinned to a CID only suppresses labels pinned to that CID. */
function overrideSuppressesSql(o: string, l: string): string {
  return `${o}.subject = ${l}.uri AND (${o}.src IS NULL OR ${o}.src = ${l}.src)
    AND (${o}.val = '' OR ${o}.val = ${l}.val) AND ${o}.cts > ${l}.cts
    AND (${o}.cid IS NULL OR ${o}.cid = ${l}.cid)`;
}

/** Instance-owned private state, bind separately from projection generations. */
export function buildModerationReportsSchema(d: SqlDialect): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS moderation_report_limits (
      reporter TEXT PRIMARY KEY, window_start ${d.bigintType} NOT NULL,
      used INTEGER NOT NULL, last_id TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS moderation_reports (
      id TEXT PRIMARY KEY, reporter TEXT NOT NULL, subject_uri TEXT NOT NULL,
      subject_did TEXT NOT NULL, subject_cid TEXT, reason_type TEXT NOT NULL,
      reason TEXT, status TEXT NOT NULL DEFAULT 'open', resolution TEXT,
      action_uri TEXT, created_at ${d.bigintType} NOT NULL, resolved_at ${d.bigintType}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_moderation_reports_status ON moderation_reports(status, created_at, id)`,
    `CREATE INDEX IF NOT EXISTS idx_moderation_reports_reporter ON moderation_reports(reporter, created_at)`,
  ];
}

export async function initModerationReports(db: Database): Promise<void> {
  await db.batch(
    buildModerationReportsSchema(getDialect(db)).map((sql) => db.prepare(sql)),
  );
}

function nowSql(d: SqlDialect): string {
  return isPostgresDialect(d)
    ? "EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)"
    : "CAST(strftime('%s', 'now') AS INTEGER)";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Active-row predicate for `moderation_hidden`. The current time is inlined
 * when the SQL is built, so build query text per request. */
export function activeHiddenSql(alias = "moderation_hidden"): string {
  const now = nowSeconds();
  return `(${alias}.starts_at IS NULL OR ${alias}.starts_at <= ${now})
    AND (${alias}.exp IS NULL OR ${alias}.exp > ${now})`;
}

/** Public visibility predicate for a records-table alias. Indexed point
 * lookups on the materialized `moderation_hidden` table, never a scan.
 * Custom SQL over Contrail record tables should include this predicate. */
export function visibleRecordSql(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM moderation_hidden mh
    WHERE mh.subject IN (${alias}.did, ${alias}.uri)
    AND (mh.cid = '' OR mh.cid = ${alias}.cid) AND ${activeHiddenSql("mh")})`;
}

/** Subjects (DIDs or URIs, any version) currently hidden. */
export async function hiddenSubjects(
  db: Database,
  subjects: string[],
): Promise<Set<string>> {
  if (!subjects.length) return new Set();
  const rows = await batchedInQuery<{ subject: string }>(
    db,
    `SELECT DISTINCT subject FROM moderation_hidden
      WHERE subject IN (__IN__) AND cid = '' AND ${activeHiddenSql()}`,
    [],
    [...new Set(subjects)],
  );
  return new Set(rows.map((r) => r.subject));
}

export async function isAccountHidden(
  db: Database,
  did: string,
): Promise<boolean> {
  return (await hiddenSubjects(db, [did])).has(did);
}

function hasCountedRelations(config: ContrailConfig): boolean {
  return Object.values(config.collections).some((c) =>
    Object.values(c.relations ?? {}).some((r) => r.count !== false),
  );
}

/** Opaque per-batch token so concurrent transactions never share dirty rows. */
export function moderationDirtyToken(): string {
  return crypto.randomUUID();
}

export function markModerationDirtyStatements(
  db: Database,
  token: string,
  subjects: Iterable<string>,
  guard?: ModerationWriteGuard,
): Statement[] {
  const unique = [...new Set(subjects)];
  const out: Statement[] = [];
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40);
    out.push(
      db
        .prepare(
          `INSERT INTO moderation_dirty (token, subject)
          ${guard ? "SELECT * FROM (" : ""}VALUES ${chunk.map(() => "(?, ?)").join(", ")}${guard ? `) AS dirty_subjects WHERE ${guard.sql}` : ""}
          ON CONFLICT(token, subject) DO NOTHING`,
        )
        .bind(...chunk.flatMap((subject) => [token, subject]), ...(guard?.bindings ?? [])),
    );
  }
  return out;
}

/** Recompute `moderation_hidden` for every subject marked under `token`, queue
 * relation recounts for now and for each future visibility boundary, then
 * clear the marks. Runs inside the caller's batch, after its writes. */
export function flushModerationDirtyStatements(
  db: Database,
  /** Omit only when relation counts are known not to be configured. */
  config: ContrailConfig | undefined,
  token: string,
): Statement[] {
  const now = nowSeconds();
  const dirty = (column: string) =>
    `${column} IN (SELECT subject FROM moderation_dirty WHERE token = ?)`;
  const suppressing = `FROM moderation_overrides o
    JOIN moderation_sources m ON m.did = o.moderator AND m.moderator = 1
    WHERE ${overrideSuppressesSql("o", "l")} AND s.moderator = 0`;
  const statements = moderationLockStatements(db);
  const recount = !!config && hasCountedRelations(config);
  if (recount)
    statements.push(
      db
        .prepare(
          `INSERT INTO moderation_hidden_snapshot (token, subject, cid, starts_at, exp)
          SELECT CAST(? AS TEXT), subject, cid, starts_at, exp FROM moderation_hidden
          WHERE ${dirty("subject")}`,
        )
        .bind(token, token),
    );
  statements.push(
    db.prepare(`DELETE FROM moderation_hidden WHERE ${dirty("subject")}`).bind(token),
    db
      .prepare(
        `INSERT INTO moderation_hidden (subject, kind, cid, starts_at, exp)
        SELECT l.uri, 'label', COALESCE(l.cid, ''), (SELECT MAX(o.exp) ${suppressing}), l.exp
        FROM labels l JOIN moderation_sources s ON s.did = l.src AND s.enforced = 1
        WHERE ${dirty("l.uri")} AND s.moderator = 0
          AND l.val IN (${HIDE_VALUES_SQL}) AND l.neg = 0
          AND (l.exp IS NULL OR l.exp > ?)
          AND NOT EXISTS (SELECT 1 FROM labels newer
            WHERE newer.src = l.src AND newer.uri = l.uri AND newer.val = l.val AND newer.cts > l.cts)
          AND NOT EXISTS (SELECT 1 ${suppressing} AND o.exp IS NULL)`,
      )
      .bind(token, now),
    // Repository actions are independent assertions, not successive versions
    // of a label tuple. Preserve every applicable CID and expiry boundary.
    db
      .prepare(
        `INSERT INTO moderation_hidden (subject, kind, cid, starts_at, exp)
        SELECT a.subject, 'action', COALESCE(a.cid, ''), NULL, a.exp
        FROM moderation_actions a
        JOIN moderation_sources s ON s.did = a.src AND s.moderator = 1
        WHERE ${dirty("a.subject")} AND a.action IN (${HIDE_VALUES_SQL})
          AND (a.exp IS NULL OR a.exp > ?)`,
      )
      .bind(token, now),
    db
      .prepare(
        `INSERT INTO moderation_hidden (subject, kind, cid, starts_at, exp)
        SELECT did, 'account', '', NULL, NULL FROM account_state
        WHERE ${dirty("did")} AND ${HIDDEN_ACCOUNT_SQL}`,
      )
      .bind(token),
  );
  if (recount) {
    // Kinds collapse: only the set of (cid, time bounds) affects visibility.
    // Unchanged subjects (routine account events, policy rechecks) would
    // otherwise page through every child record for nothing.
    const changed = `${token}:changed`;
    const rows = (from: string, where: string) =>
      `SELECT subject, cid, starts_at, exp FROM ${from} WHERE ${where}`;
    statements.push(
      db
        .prepare(
          `INSERT INTO moderation_dirty (token, subject)
          SELECT CAST(? AS TEXT), subject FROM (
            ${rows("moderation_hidden", dirty("subject"))}
            EXCEPT ${rows("moderation_hidden_snapshot", "token = ?")}
          ) AS added WHERE true
          UNION
          SELECT CAST(? AS TEXT), subject FROM (
            ${rows("moderation_hidden_snapshot", "token = ?")}
            EXCEPT ${rows("moderation_hidden", dirty("subject"))}
          ) AS removed WHERE true
          ON CONFLICT(token, subject) DO NOTHING`,
        )
        .bind(changed, token, token, changed, token, token),
      db
        .prepare(
          `INSERT INTO moderation_recount_queue (subject, due_at, cursor)
          SELECT subject, 0, NULL FROM moderation_dirty WHERE token = ?
          ON CONFLICT(subject, due_at) DO UPDATE SET cursor = NULL`,
        )
        .bind(changed),
    );
    for (const column of ["starts_at", "exp"])
      statements.push(
        db
          .prepare(
            `INSERT INTO moderation_recount_queue (subject, due_at, cursor)
            SELECT DISTINCT subject, ${column}, NULL FROM moderation_hidden
            WHERE ${column} > ? AND ${dirty("subject")}
            ON CONFLICT(subject, due_at) DO NOTHING`,
          )
          .bind(now, changed),
      );
    statements.push(
      db.prepare("DELETE FROM moderation_hidden_snapshot WHERE token = ?").bind(token),
      db.prepare("DELETE FROM moderation_dirty WHERE token = ?").bind(changed),
    );
  }
  statements.push(
    db.prepare("DELETE FROM moderation_dirty WHERE token = ?").bind(token),
  );
  return statements;
}

/** Mark `subjects` and recompute their enforcement state in one step. */
export function recomputeModerationStatements(
  db: Database,
  config: ContrailConfig | undefined,
  subjects: Iterable<string>,
  guard?: ModerationWriteGuard,
): Statement[] {
  const marks = [...new Set(subjects)];
  if (!marks.length) return [];
  const token = moderationDirtyToken();
  return [
    ...markModerationDirtyStatements(db, token, marks, guard),
    ...flushModerationDirtyStatements(db, config, token),
  ];
}

export function labelBackfillEnqueueStatements(
  db: Database,
  dids: Iterable<string>,
  config?: ContrailConfig,
  /** Run before the identity insert: recheck labels admitted before resolution. */
  identityDiscovery = false,
): Statement[] {
  const sources = (config?.labels?.sources ?? []).filter(
    (s) => s.subjects === "known" && !s.records,
  );
  return [...new Set(dids)].flatMap((did) =>
    sources.map((s) =>
      db
        .prepare(
          `INSERT INTO label_backfill_queue (src, did) VALUES (?, ?) ON CONFLICT(src, did)
            ${
              identityDiscovery
                ? `DO UPDATE SET completed = 0, cursor = NULL, retries = 0, next_attempt_at = 0,
                  generation = label_backfill_queue.generation + 1
              WHERE NOT EXISTS (SELECT 1 FROM identities WHERE did = excluded.did)`
                : "DO NOTHING"
            }`,
        )
        .bind(s.did, did),
    ),
  );
}

/** The subset of `dids` whose account events `accountUpdateStatements` would
 * store. Lets ingestion drop network-wide account traffic before it consumes
 * buffer/budget or SQL. The statements keep the same check authoritatively. */
export async function knownAccountDids(
  db: Database,
  config: ContrailConfig,
  dids: Iterable<string>,
): Promise<Set<string>> {
  const known = new Set<string>();
  let pending = [...new Set(dids)];
  const tables = [
    "account_state",
    "identities",
    ...Object.keys(config.collections).map(recordsTableName),
  ];
  for (const table of tables) {
    if (!pending.length) break;
    const rows = await batchedInQuery<{ did: string }>(
      db,
      `SELECT DISTINCT did FROM ${table} WHERE did IN (__IN__)`,
      [],
      pending,
    );
    for (const row of rows) known.add(row.did);
    pending = pending.filter((did) => !known.has(did));
  }
  return known;
}

/** Account state and the source checkpoint are committed in the same batch.
 * Duplicate/stale lifecycle events cannot reverse newer actor state. Unknown
 * inactive statuses fail closed through active=0. Deleted data remains retained
 * but invisible until an explicit newer reactivation; no guessed repo purge.
 *
 * Only actors this instance holds data for are stored. Both active and inactive
 * events for known DIDs retain ordering checkpoints, so a delayed inactive
 * event cannot reverse a newer initial active event. Existing rows continue
 * updating; network-wide account traffic for unknown DIDs is a no-op. */
export function accountUpdateStatements(
  db: Database,
  updates: AccountUpdate[],
  config: ContrailConfig,
): Statement[] {
  if (!updates.length) return [];
  const knownChecks = [
    "EXISTS (SELECT 1 FROM identities WHERE did = ?)",
    ...Object.keys(config.collections).map(
      (short) =>
        `EXISTS (SELECT 1 FROM ${recordsTableName(short)} WHERE did = ?)`,
    ),
  ];
  // Mixed action/lifecycle batches already hold this lock before reaching
  // their account writes. Account-only batches must take it before locking
  // account_state too, not just during the later hidden-state recompute.
  const stmts = moderationLockStatements(db);
  stmts.push(...updates.map((u) =>
    db
      .prepare(
        `INSERT INTO account_state (did, active, status, source, epoch, cursor, time_us)
    SELECT ?, CAST(? AS INTEGER), ?, ?, ?, CAST(? AS BIGINT), CAST(? AS BIGINT)
    WHERE EXISTS (SELECT 1 FROM account_state WHERE did = ?) OR ${knownChecks.join(" OR ")}
    ON CONFLICT(did) DO UPDATE SET active = excluded.active, status = excluded.status,
      source = excluded.source, epoch = excluded.epoch, cursor = excluded.cursor, time_us = excluded.time_us
    WHERE CASE WHEN account_state.source = excluded.source
      AND COALESCE(account_state.epoch, '') = COALESCE(excluded.epoch, '')
      THEN excluded.cursor > account_state.cursor ELSE excluded.time_us > account_state.time_us END`,
      )
      .bind(
        u.did,
        u.active ? 1 : 0,
        u.active ? null : (u.status ?? "inactive"),
        config.orderedSource?.source ?? "jetstream",
        config.orderedSource?.epoch ?? null,
        u.cursor,
        u.timeUs,
        u.did,
        ...knownChecks.map(() => u.did),
      ),
  ));
  const token = moderationDirtyToken();
  const dids = [...new Set(updates.map((u) => u.did))];
  for (let i = 0; i < dids.length; i += 50) {
    const chunk = dids.slice(i, i + 50);
    stmts.push(
      db
        .prepare(
          `INSERT INTO moderation_dirty (token, subject)
          SELECT CAST(? AS TEXT), did FROM account_state WHERE did IN (${chunk.map(() => "?").join(",")})
          ON CONFLICT(token, subject) DO NOTHING`,
        )
        .bind(token, ...chunk),
    );
  }
  stmts.push(...flushModerationDirtyStatements(db, config, token));
  return stmts;
}

/** Derived action state is rebuilt inside canonical record projection. Keeping
 * each record separately means deleting one of two equal actions does not undo
 * the other. Updates retract the OLD subject/value as well as applying the new.
 * Only subjects touched by this batch are rebuilt. */
export function actionProjectionStatements(
  db: Database,
  events: IngestEvent[],
  config: ContrailConfig,
): Statement[] {
  const actions = events.filter(
    (e) =>
      e.collection === MODERATION_ACTION_NSID &&
      config.moderation?.moderators.includes(e.did),
  );
  if (!actions.length) return [];
  const token = moderationDirtyToken();
  const stmts: Statement[] = [];
  for (const e of actions) {
    for (const [table, column] of [
      ["moderation_actions", "src"],
      ["moderation_overrides", "moderator"],
    ])
      stmts.push(
        db
          .prepare(
            `INSERT INTO moderation_dirty (token, subject)
            SELECT DISTINCT CAST(? AS TEXT), subject FROM ${table} WHERE uri = ? AND ${column} = ?
            ON CONFLICT(token, subject) DO NOTHING`,
          )
          .bind(token, e.uri, e.did),
      );
    stmts.push(
      db.prepare("DELETE FROM moderation_actions WHERE uri = ?").bind(e.uri),
      db.prepare("DELETE FROM moderation_overrides WHERE uri = ?").bind(e.uri),
    );
    const a = e.record ? parseModerationAction(JSON.parse(e.record)) : null;
    if (!a || e.operation === "delete") continue;
    stmts.push(...markModerationDirtyStatements(db, token, [a.subject]));
    // A forward-dated createdAt must not pre-empt labels issued before the
    // action was observed. Clamp to the source's observation time rather than
    // the projection time, so re-projecting the same event keeps its cts.
    const observedMs = e.source?.time_us ? Math.floor(e.source.time_us / 1000) : Date.now();
    const cts = Math.min(Date.parse(a.createdAt), observedMs, Date.now());
    const exp = a.expiresAt ? Math.floor(Date.parse(a.expiresAt) / 1000) : null;
    if (a.action === "override") {
      for (const val of new Set(a.labels ?? [""]))
        stmts.push(
          db
            .prepare(
              `INSERT INTO moderation_overrides
        (uri, moderator, subject, src, val, cid, exp, cts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              e.uri,
              e.did,
              a.subject,
              a.src ?? null,
              val,
              a.subjectCid ?? null,
              exp,
              cts,
            ),
        );
    } else
      stmts.push(
        db
          .prepare(
            `INSERT INTO moderation_actions (uri, src, subject, action, cid, exp, cts)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            e.uri,
            e.did,
            a.subject,
            a.action,
            a.subjectCid ?? null,
            exp,
            cts,
          ),
      );
  }
  stmts.push(...flushModerationDirtyStatements(db, config, token));
  return stmts;
}
