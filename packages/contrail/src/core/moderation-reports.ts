import { isDid, isCid, parseResourceUri } from "@atcute/lexicons/syntax";
import type { ContrailConfig, Database } from "./types";
import {
  recordsTableName,
  resolveCollectionKey,
  normalizeProfileConfig,
} from "./types";
import {
  MODERATION_ACTION_NSID,
  subjectDid,
  activeHiddenSql,
  knownAccountDids,
} from "./moderation";
import { hydrateLabels } from "./labels/hydrate";
import { batchedInQuery, formatRecord } from "./router/helpers";
import { REPORT_REASON_TYPES } from "../moderation-contract";
import type { ReportPage } from "../moderation-client";

/** Domain failure shared by session-backed apps and the service-auth HTTP routes. */
export class ModerationReportError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 429,
    public readonly error: string,
    message?: string,
    public readonly retryAfter?: number,
  ) {
    super(message ?? error);
    this.name = "ModerationReportError";
  }
}

export interface ModerationReportsOptions {
  projectionDb: Database;
  /** Stable instance-owned storage. Deliberately explicit; never silently falls back. */
  reportsDb: Database;
  /** Resolved instance config (e.g. contrail.config or resolveConfig(config)). */
  config: ContrailConfig;
}

export interface ListModerationReportsInput {
  status?: "open" | "resolved";
  limit?: number;
  cursor?: string;
}

function objectInput(input: unknown): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ModerationReportError(400, "InvalidRequest");
  return input as Record<string, any>;
}

/** Server-only report operations. The embedding app MUST authenticate `actor`
 * from its session, never from request input, and protect mutations against CSRF.
 * These operations perform validation, quotas and moderator authorization, but
 * do not verify sessions or mint/verify service tokens. `moderation.reports: false`
 * disables only XRPC exposure; these explicit server operations remain usable.
 * Initialize both databases before calling, using initModerationReports for
 * reportsDb. Do not expose these functions through an anonymous transport.
 */
export function createModerationReports(options: ModerationReportsOptions) {
  const { projectionDb, reportsDb: db, config } = options;
  function authorize(actor: string, admin = false) {
    if (typeof actor !== "string" || !isDid(actor))
      throw new ModerationReportError(401, "AuthenticationRequired");
    if (
      !config.moderation ||
      (admin && !config.moderation.moderators.includes(actor))
    )
      throw new ModerationReportError(403, "Forbidden");
  }
  return {
    async create(actor: string, input: unknown) {
      authorize(actor);
      const body = objectInput(input);
      const s = body.subject;
      let uri: string;
      let did: string | null;
      let cid: string | null = null;
      if (
        s?.$type === "com.atproto.admin.defs#repoRef" &&
        typeof s.did === "string" &&
        isDid(s.did)
      ) {
        uri = s.did;
        did = s.did;
      } else if (
        s?.$type === "com.atproto.repo.strongRef" &&
        typeof s.uri === "string" &&
        s.uri.startsWith("at://") &&
        isCid(s.cid) &&
        s.cid.length <= 256 &&
        (did = subjectDid(s.uri))
      ) {
        uri = s.uri;
        cid = s.cid;
      } else
        throw new ModerationReportError(
          400,
          "InvalidRequest",
          "subject must be a repoRef or strongRef with a DID authority",
        );
      if (
        !(REPORT_REASON_TYPES as readonly string[]).includes(body.reasonType) ||
        (body.reason !== undefined &&
          (typeof body.reason !== "string" || !withinReasonLimits(body.reason)))
      ) {
        throw new ModerationReportError(400, "InvalidRequest");
      }
      if (!(await isIndexedSubject(projectionDb, config, uri, did!)))
        throw new ModerationReportError(
          400,
          "InvalidRequest",
          "subject is not indexed by this service",
        );
      const now = Date.now();
      let id = 0;
      for (let attempt = 0; ; attempt++) {
        // Safe JSON integer, no clock/sequence collision across concurrent Workers.
        const bytes = crypto.getRandomValues(new Uint8Array(6));
        id = bytes.reduce((n, b) => n * 256 + b, 0);
        try {
          await db.batch([
            db
              .prepare(
                `INSERT INTO moderation_report_limits (reporter, window_start, used, last_id) VALUES (?, ?, 1, ?)
            ON CONFLICT(reporter) DO UPDATE SET
              window_start = CASE WHEN moderation_report_limits.window_start <= ? THEN excluded.window_start ELSE moderation_report_limits.window_start END,
              used = CASE WHEN moderation_report_limits.window_start <= ? THEN 1 ELSE moderation_report_limits.used + 1 END,
              last_id = excluded.last_id
            WHERE moderation_report_limits.window_start <= ? OR moderation_report_limits.used < 10`,
              )
              .bind(
                actor,
                now,
                String(id),
                now - 3_600_000,
                now - 3_600_000,
                now - 3_600_000,
              ),
            db
              .prepare(
                `INSERT INTO moderation_reports (id, reporter, subject_uri, subject_did, subject_cid, reason_type, reason, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, CAST(? AS BIGINT) WHERE EXISTS
            (SELECT 1 FROM moderation_report_limits WHERE reporter = ? AND last_id = ?)`,
              )
              .bind(
                String(id),
                actor,
                uri,
                did,
                cid,
                body.reasonType,
                body.reason ?? null,
                now,
                actor,
                String(id),
              ),
          ]);
          break;
        } catch (error) {
          // A random ID collision fails the whole transaction, quota included.
          // Retry with a fresh ID; anything else is a real storage failure.
          const taken = await db
            .prepare("SELECT 1 FROM moderation_reports WHERE id = ?")
            .bind(String(id))
            .first()
            .catch(() => null);
          if (!taken || attempt >= 2) throw error;
        }
      }
      const stored = await db
        .prepare("SELECT id FROM moderation_reports WHERE id = ?")
        .bind(String(id))
        .first();
      if (!stored) {
        throw new ModerationReportError(
          429,
          "RateLimitExceeded",
          undefined,
          3600,
        );
      }
      return {
        id,
        reasonType: body.reasonType,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        // Echo the validated subject, never the caller's raw object.
        subject: cid
          ? { $type: "com.atproto.repo.strongRef", uri, cid }
          : { $type: "com.atproto.admin.defs#repoRef", did },
        reportedBy: actor,
        createdAt: new Date(now).toISOString(),
      };
    },
    async list(
      actor: string,
      input: ListModerationReportsInput = {},
    ): Promise<ReportPage> {
      authorize(actor, true);
      objectInput(input);
      const status = input.status ?? "open";
      const limit = input.limit ?? 50;
      if (
        !["open", "resolved"].includes(status) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (input.cursor !== undefined &&
          (typeof input.cursor !== "string" || input.cursor.length > 1024))
      )
        throw new ModerationReportError(400, "InvalidRequest");
      let cursor: [number, string] | null = null;
      if (input.cursor)
        try {
          cursor = JSON.parse(atob(input.cursor));
          if (
            !Array.isArray(cursor) ||
            cursor.length !== 2 ||
            !Number.isSafeInteger(cursor[0]) ||
            typeof cursor[1] !== "string" ||
            !/^\d+$/.test(cursor[1])
          )
            throw new Error();
        } catch {
          throw new ModerationReportError(400, "InvalidRequest");
        }
      const rows = await db
        .prepare(
          `SELECT * FROM moderation_reports WHERE status = ?
      ${cursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .bind(
          status,
          ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []),
          limit,
        )
        .all<ReportRow>();
      const previewById = await previews(projectionDb, config, rows.results);
      const reports = rows.results.map((r) => ({
        id: Number(r.id),
        reportedBy: r.reporter,
        subject: subject(r),
        reasonType: r.reason_type,
        ...(r.reason ? { reason: r.reason } : {}),
        status: r.status,
        resolution: r.resolution,
        actionUri: r.action_uri,
        createdAt: new Date(Number(r.created_at)).toISOString(),
        resolvedAt:
          r.resolved_at === null
            ? null
            : new Date(Number(r.resolved_at)).toISOString(),
        preview: previewById.get(r.id),
      }));
      const last = rows.results.at(-1);
      return {
        reports,
        ...(last && reports.length === limit
          ? { cursor: btoa(JSON.stringify([Number(last.created_at), last.id])) }
          : {}),
      };
    },
    async resolve(actor: string, input: unknown) {
      authorize(actor, true);
      const body = objectInput(input);
      if (
        !Number.isSafeInteger(body.id) ||
        body.id < 0 ||
        (body.resolution !== undefined &&
          (typeof body.resolution !== "string" ||
            body.resolution.length > 4000))
      )
        throw new ModerationReportError(400, "InvalidRequest");
      if (body.actionUri !== undefined) {
        try {
          const p = parseResourceUri(body.actionUri);
          if (
            p.collection !== MODERATION_ACTION_NSID ||
            !p.rkey ||
            !config.moderation!.moderators.includes(p.repo)
          )
            throw new Error();
        } catch {
          throw new ModerationReportError(400, "InvalidRequest");
        }
      }
      const exists = await db
        .prepare("SELECT id FROM moderation_reports WHERE id = ?")
        .bind(String(body.id))
        .first();
      if (!exists) throw new ModerationReportError(404, "ReportNotFound");
      await db
        .prepare(
          "UPDATE moderation_reports SET status = 'resolved', resolution = ?, action_uri = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
        )
        .bind(
          body.resolution ?? null,
          body.actionUri ?? null,
          Date.now(),
          String(body.id),
        )
        .run();
      return {};
    },
  };
}

/** The createReport Lexicon bounds `reason` by graphemes and UTF-8 bytes. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function withinReasonLimits(reason: string): boolean {
  if (new TextEncoder().encode(reason).length > 20_000) return false;
  let count = 0;
  for (const _ of graphemes.segment(reason)) if (++count > 2000) return false;
  return true;
}

interface ReportRow {
  id: string;
  reporter: string;
  subject_uri: string;
  subject_did: string;
  subject_cid: string | null;
  reason_type: string;
  reason: string | null;
  status: "open" | "resolved";
  resolution: string | null;
  action_uri: string | null;
  created_at: number;
  resolved_at: number | null;
}

function subject(row: ReportRow) {
  return row.subject_cid
    ? {
        $type: "com.atproto.repo.strongRef" as const,
        uri: row.subject_uri,
        cid: row.subject_cid,
      }
    : {
        $type: "com.atproto.admin.defs#repoRef" as const,
        did: row.subject_did as `did:${string}:${string}`,
      };
}

/** Reports are limited to subjects this instance indexes, so arbitrary DIDs
 * and URIs cannot fill the private inbox. Hidden subjects remain reportable. */
async function isIndexedSubject(
  db: Database,
  config: ContrailConfig,
  uri: string,
  did: string,
): Promise<boolean> {
  if (!uri.startsWith("at://"))
    return (await knownAccountDids(db, config, [did])).has(did);
  const key = resolveCollectionKey(config, parseResourceUri(uri).collection!);
  return (
    !!key &&
    !!(await db
      .prepare(`SELECT 1 FROM ${recordsTableName(key)} WHERE uri = ?`)
      .bind(uri)
      .first())
  );
}

interface ReportPreview {
  records: any[];
  labels: Record<string, unknown[]>;
  hidden: boolean;
}

/** Never use the public pipeline for moderator previews: moderators need the
 * locally indexed hidden subject too. No PDS fetch and no private data joins.
 * Batched per page: a fixed number of queries regardless of report count. */
async function previews(
  db: Database,
  config: ContrailConfig,
  rows: ReportRow[],
): Promise<Map<string, ReportPreview>> {
  const recordsByUri = new Map<string, any>();
  const uris = new Map<string, string[]>();
  const select = (key: string, list: string[]) =>
    uris.set(key, [...(uris.get(key) ?? []), ...list]);
  const profileConfigs = (config.profiles ?? []).map(normalizeProfileConfig);
  const profileUris = (did: string) =>
    profileConfigs.map((pc) => ({
      pc,
      uri: `at://${did}/${pc.collection}/${pc.rkey ?? "self"}`,
    }));
  for (const row of rows) {
    if (row.subject_uri.startsWith("at://")) {
      const key = resolveCollectionKey(
        config,
        parseResourceUri(row.subject_uri).collection!,
      );
      if (key) select(key, [row.subject_uri]);
    } else
      for (const { pc, uri } of profileUris(row.subject_did))
        select(pc.shortName ?? pc.collection, [uri]);
  }
  for (const [key, list] of uris) {
    const nsid = config.collections[key]?.collection ?? key;
    const found = await batchedInQuery<any>(
      db,
      `SELECT * FROM ${recordsTableName(key)} WHERE uri IN (__IN__)`,
      [],
      [...new Set(list)],
    );
    for (const record of found)
      recordsByUri.set(
        record.uri,
        formatRecord({ ...record, collection: nsid }),
      );
  }
  const subjects = [
    ...new Set(rows.flatMap((r) => [r.subject_uri, r.subject_did])),
  ];
  const labelSubjects = [...new Set([...subjects, ...recordsByUri.keys()])];
  const labels = await hydrateLabels(
    db,
    labelSubjects,
    config.labels?.sources.map((s) => s.did) ?? [],
    new Map([...recordsByUri.values()].map((r) => [r.uri, r.cid])),
  );
  const hiddenRows = await batchedInQuery<{ subject: string; cid: string }>(
    db,
    `SELECT subject, cid FROM moderation_hidden WHERE subject IN (__IN__) AND ${activeHiddenSql()}`,
    [],
    subjects,
  );
  const result = new Map<string, ReportPreview>();
  for (const row of rows) {
    const records = row.subject_uri.startsWith("at://")
      ? [recordsByUri.get(row.subject_uri)].filter(Boolean)
      : profileUris(row.subject_did)
          .map(({ uri }) => recordsByUri.get(uri))
          .filter(Boolean);
    const cid = records[0]?.cid ?? row.subject_cid;
    const previewSubjects = [
      ...new Set([
        row.subject_uri,
        row.subject_did,
        ...records.map((r) => r.uri),
      ]),
    ];
    result.set(row.id, {
      records,
      labels: Object.fromEntries(
        previewSubjects.filter((s) => labels[s]).map((s) => [s, labels[s]!]),
      ),
      hidden: hiddenRows.some(
        (h) =>
          (h.subject === row.subject_uri || h.subject === row.subject_did) &&
          (h.cid === "" || h.cid === cid),
      ),
    });
  }
  return result;
}
