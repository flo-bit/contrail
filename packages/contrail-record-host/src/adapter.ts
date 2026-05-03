/** Default {@link RecordHost} implementation backed by a Database.
 *
 *  Owns the host-side tables — `spaces_records_<short>` (per-collection),
 *  `spaces_blobs`, `record_host_enrollments` — and exposes record CRUD,
 *  blob metadata management, enrollment, and `findOrphanBlobs` for GC.
 *
 *  Independent of the authority adapter: takes a Database directly, doesn't
 *  inherit from anything. Bundles that want a single adapter satisfying both
 *  roles instantiate this alongside HostedAuthorityAdapter against the same
 *  DB. The duplication of the underlying tables is fine — `IF NOT EXISTS`
 *  guards make schema application idempotent. */

import type {
  ContrailConfig,
  Database,
  RelationConfig,
  ResolvedContrailConfig,
  RecordHost,
  BlobMetaRow,
  CollectionCount,
  EnrollmentRow,
  ListBlobsOptions,
  ListBlobsResult,
  ListOptions,
  ListResult,
  StoredRecord,
} from "@atmo-dev/contrail-base";
import {
  shortNameForNsid,
  spacesRecordsTableName,
  countColumnName,
  groupedCountColumnName,
  getRelationField,
  getNestedValue,
  getDialect,
  buildRecordUri,
} from "@atmo-dev/contrail-base";

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function toNum(v: unknown): number {
  return typeof v === "string" ? Number(v) : (v as number);
}

export function mapBlobMetaRow(row: any): BlobMetaRow {
  return {
    spaceUri: row.space_uri,
    cid: row.cid,
    mimeType: row.mime_type,
    size: Number(row.size),
    authorDid: row.author_did,
    createdAt: toNum(row.created_at),
  };
}

export function mapEnrollmentRow(row: any): EnrollmentRow {
  return {
    spaceUri: row.space_uri,
    authorityDid: row.authority_did,
    enrolledAt: toNum(row.enrolled_at),
    enrolledBy: row.enrolled_by,
  };
}

/** Row mapper for per-collection spaces_records_<short> tables.
 *  `collection` is injected by the caller (known from the table name). */
export function mapRecordRow(row: any, collection: string): StoredRecord {
  return {
    spaceUri: row.space_uri,
    collection,
    authorDid: row.did,
    rkey: row.rkey,
    cid: row.cid ?? null,
    record: parseJson<Record<string, unknown>>(row.record) ?? {},
    createdAt: toNum(row.time_us),
  };
}

export class HostedRecordHostAdapter implements RecordHost {
  constructor(
    protected readonly db: Database,
    protected readonly config?: ContrailConfig
  ) {}

  /** Resolve the per-collection spaces table name, or throw if the collection
   *  isn't configured (and therefore has no table). */
  protected tableFor(collection: string): string {
    if (!this.config) {
      throw new Error(
        `HostedRecordHostAdapter: config not provided; cannot resolve table for collection ${collection}`
      );
    }
    const short = shortNameForNsid(this.config, collection);
    if (!short) {
      throw new Error(
        `HostedRecordHostAdapter: collection ${collection} is not configured in this deployment`
      );
    }
    return spacesRecordsTableName(short);
  }

  // ---- Enrollment ----

  async enroll(input: EnrollmentRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO record_host_enrollments (space_uri, authority_did, enrolled_at, enrolled_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (space_uri) DO UPDATE SET
           authority_did = excluded.authority_did,
           enrolled_at = excluded.enrolled_at,
           enrolled_by = excluded.enrolled_by`
      )
      .bind(input.spaceUri, input.authorityDid, input.enrolledAt, input.enrolledBy)
      .run();
  }

  async getEnrollment(spaceUri: string): Promise<EnrollmentRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM record_host_enrollments WHERE space_uri = ?`)
      .bind(spaceUri)
      .first<any>();
    return row ? mapEnrollmentRow(row) : null;
  }

  async listEnrollments(
    options: { authorityDid?: string; limit?: number } = {}
  ): Promise<EnrollmentRow[]> {
    const limit = Math.min(options.limit ?? 200, 1000);
    if (options.authorityDid) {
      const { results } = await this.db
        .prepare(
          `SELECT * FROM record_host_enrollments WHERE authority_did = ? ORDER BY enrolled_at DESC LIMIT ?`
        )
        .bind(options.authorityDid, limit)
        .all<any>();
      return results.map(mapEnrollmentRow);
    }
    const { results } = await this.db
      .prepare(`SELECT * FROM record_host_enrollments ORDER BY enrolled_at DESC LIMIT ?`)
      .bind(limit)
      .all<any>();
    return results.map(mapEnrollmentRow);
  }

  async removeEnrollment(spaceUri: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM record_host_enrollments WHERE space_uri = ?`)
      .bind(spaceUri)
      .run();
  }

  // ---- Records ----

  async putRecord(record: StoredRecord): Promise<void> {
    const table = this.tableFor(record.collection);
    const uri = buildRecordUri(record.authorDid, record.collection, record.rkey);

    const childShort = this.config ? shortNameForNsid(this.config, record.collection) : null;
    const prev = childShort
      ? await this.db
          .prepare(`SELECT record FROM ${table} WHERE space_uri = ? AND did = ? AND rkey = ?`)
          .bind(record.spaceUri, record.authorDid, record.rkey)
          .first<{ record: unknown } | null>()
      : null;
    const beforeRecord = parseJson<Record<string, unknown>>(prev?.record ?? null);

    await this.db
      .prepare(
        `INSERT INTO ${table} (space_uri, uri, did, rkey, cid, record, time_us, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (space_uri, did, rkey) DO UPDATE SET
           uri = excluded.uri,
           cid = excluded.cid,
           record = excluded.record,
           time_us = excluded.time_us,
           indexed_at = excluded.indexed_at`
      )
      .bind(
        record.spaceUri,
        uri,
        record.authorDid,
        record.rkey,
        record.cid,
        JSON.stringify(record.record),
        record.createdAt,
        Date.now()
      )
      .run();

    if (childShort && this.config) {
      await this.recountParentsForSpace(
        record.spaceUri,
        childShort,
        beforeRecord,
        record.record,
        record.authorDid
      );
    }
  }

  async getRecord(
    spaceUri: string,
    collection: string,
    authorDid: string,
    rkey: string
  ): Promise<StoredRecord | null> {
    const table = this.tableFor(collection);
    const row = await this.db
      .prepare(
        `SELECT * FROM ${table}
         WHERE space_uri = ? AND did = ? AND rkey = ?`
      )
      .bind(spaceUri, authorDid, rkey)
      .first<any>();
    return row ? mapRecordRow(row, collection) : null;
  }

  async listRecords(
    spaceUri: string,
    collection: string,
    options: ListOptions = {}
  ): Promise<ListResult> {
    const table = this.tableFor(collection);
    const limit = Math.min(options.limit ?? 50, 200);
    const clauses: string[] = ["space_uri = ?"];
    const params: any[] = [spaceUri];

    if (options.byUser) {
      clauses.push("did = ?");
      params.push(options.byUser);
    }
    if (options.cursor) {
      clauses.push("time_us < ?");
      params.push(Number(options.cursor));
    }

    const sql = `SELECT * FROM ${table}
      WHERE ${clauses.join(" AND ")}
      ORDER BY time_us DESC
      LIMIT ?`;
    params.push(limit + 1);

    const { results } = await this.db.prepare(sql).bind(...params).all<any>();
    const records = results.map((r) => mapRecordRow(r, collection));
    let cursor: string | undefined;
    if (records.length > limit) {
      const next = records.pop()!;
      cursor = String(next.createdAt);
    }
    return { records, cursor };
  }

  async deleteRecord(
    spaceUri: string,
    collection: string,
    authorDid: string,
    rkey: string
  ): Promise<void> {
    const table = this.tableFor(collection);

    const childShort = this.config ? shortNameForNsid(this.config, collection) : null;
    const prev = childShort
      ? await this.db
          .prepare(`SELECT record FROM ${table} WHERE space_uri = ? AND did = ? AND rkey = ?`)
          .bind(spaceUri, authorDid, rkey)
          .first<{ record: unknown } | null>()
      : null;
    const beforeRecord = parseJson<Record<string, unknown>>(prev?.record ?? null);

    await this.db
      .prepare(
        `DELETE FROM ${table}
         WHERE space_uri = ? AND did = ? AND rkey = ?`
      )
      .bind(spaceUri, authorDid, rkey)
      .run();

    if (childShort && this.config) {
      await this.recountParentsForSpace(spaceUri, childShort, beforeRecord, null, authorDid);
    }
  }

  /** Recompute count columns on parent records in the same space, scoped to the
   *  targets derived from before/after versions of the written/deleted child record. */
  protected async recountParentsForSpace(
    spaceUri: string,
    childShort: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    childDid: string
  ): Promise<void> {
    if (!this.config) return;
    const config = this.config;
    const resolved = (config as ResolvedContrailConfig)._resolved;
    const childTable = spacesRecordsTableName(childShort);

    type Inbound = { parentShort: string; relationName: string; rel: RelationConfig };
    const inbound: Inbound[] = [];
    for (const [parentShort, parentCfg] of Object.entries(config.collections)) {
      if (parentCfg.allowInSpaces === false) continue;
      for (const [relName, rel] of Object.entries(parentCfg.relations ?? {})) {
        if (rel.count === false) continue;
        if (rel.collection !== childShort) continue;
        inbound.push({ parentShort, relationName: relName, rel });
      }
    }
    if (inbound.length === 0) return;

    // Deduplicate (parent, relation, target) across before/after.
    const keyed = new Map<string, { parentShort: string; relationName: string; rel: RelationConfig; target: string }>();
    for (const { parentShort, relationName, rel } of inbound) {
      const field = getRelationField(rel);
      const collectTarget = (rec: Record<string, unknown> | null) => {
        if (!rec) return;
        if (rel.match === "did") {
          keyed.set(`${parentShort}:${relationName}:${childDid}`, {
            parentShort, relationName, rel, target: childDid,
          });
          return;
        }
        const v = getNestedValue(rec, field);
        if (typeof v === "string" && v.length > 0) {
          keyed.set(`${parentShort}:${relationName}:${v}`, {
            parentShort, relationName, rel, target: v,
          });
        }
      };
      collectTarget(before);
      collectTarget(after);
    }
    if (keyed.size === 0) return;

    const dialect = getDialect(this.db);
    const stmts: ReturnType<Database["prepare"]>[] = [];

    for (const { parentShort, relationName, rel, target } of keyed.values()) {
      const parentTable = spacesRecordsTableName(parentShort);
      const matchColumn = rel.match === "did" ? "did" : "uri";
      const field = getRelationField(rel);
      const countExpr = rel.countDistinct
        ? `COUNT(DISTINCT ${rel.countDistinct})`
        : "COUNT(*)";

      const setClauses: string[] = [];
      const binds: (string | number)[] = [];

      const totalCol = countColumnName(rel.collection);
      setClauses.push(
        `${totalCol} = (SELECT ${countExpr} FROM ${childTable} WHERE space_uri = ? AND ${dialect.jsonExtract("record", field)} = ?)`
      );
      binds.push(spaceUri, target);

      if (rel.groupBy) {
        const mapping = resolved?.relations[parentShort]?.[relationName];
        if (mapping?.groups) {
          for (const [groupKey, fullToken] of Object.entries(mapping.groups)) {
            const groupCol = groupedCountColumnName(rel.collection, groupKey);
            setClauses.push(
              `${groupCol} = (SELECT ${countExpr} FROM ${childTable} WHERE space_uri = ? AND ${dialect.jsonExtract("record", field)} = ? AND ${dialect.jsonExtract("record", rel.groupBy)} = ?)`
            );
            binds.push(spaceUri, target, fullToken);
          }
        }
      }

      binds.push(spaceUri, target);
      stmts.push(
        this.db
          .prepare(
            `UPDATE ${parentTable} SET ${setClauses.join(", ")} WHERE space_uri = ? AND ${matchColumn} = ?`
          )
          .bind(...binds)
      );
    }

    if (stmts.length > 0) await this.db.batch(stmts);
  }

  async listCollections(
    spaceUri: string,
    options: { byUser?: string } = {}
  ): Promise<CollectionCount[]> {
    if (!this.config) return [];
    const results: CollectionCount[] = [];
    for (const [short, colConfig] of Object.entries(this.config.collections)) {
      if (colConfig.allowInSpaces === false) continue;
      const table = spacesRecordsTableName(short);
      const clauses: string[] = ["space_uri = ?"];
      const params: any[] = [spaceUri];
      if (options.byUser) {
        clauses.push("did = ?");
        params.push(options.byUser);
      }
      try {
        const row = await this.db
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${clauses.join(" AND ")}`)
          .bind(...params)
          .first<{ count: number }>();
        const count = Number(row?.count ?? 0);
        if (count > 0) results.push({ collection: colConfig.collection, count });
      } catch {
        // table doesn't exist (collection added after init, or allowInSpaces toggled) — skip
      }
    }
    return results;
  }

  // ---- Blobs ----

  async putBlobMeta(row: BlobMetaRow): Promise<void> {
    const sql = `INSERT INTO spaces_blobs (space_uri, cid, mime_type, size, author_did, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (space_uri, cid) DO NOTHING`;
    await this.db
      .prepare(sql)
      .bind(row.spaceUri, row.cid, row.mimeType, row.size, row.authorDid, row.createdAt)
      .run();
  }

  async getBlobMeta(spaceUri: string, cid: string): Promise<BlobMetaRow | null> {
    const r = await this.db
      .prepare(`SELECT * FROM spaces_blobs WHERE space_uri = ? AND cid = ?`)
      .bind(spaceUri, cid)
      .first<any>();
    return r ? mapBlobMetaRow(r) : null;
  }

  async listBlobMeta(
    spaceUri: string,
    options: ListBlobsOptions = {}
  ): Promise<ListBlobsResult> {
    const limit = Math.min(options.limit ?? 50, 200);
    const clauses: string[] = ["space_uri = ?"];
    const params: any[] = [spaceUri];
    if (options.byUser) {
      clauses.push("author_did = ?");
      params.push(options.byUser);
    }
    if (options.cursor) {
      clauses.push("created_at < ?");
      params.push(Number(options.cursor));
    }
    const sql = `SELECT * FROM spaces_blobs
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?`;
    params.push(limit + 1);
    const { results } = await this.db.prepare(sql).bind(...params).all<any>();
    const blobs = results.map(mapBlobMetaRow);
    let cursor: string | undefined;
    if (blobs.length > limit) {
      const next = blobs.pop()!;
      cursor = String(next.createdAt);
    }
    return { blobs, cursor };
  }

  async deleteBlobMeta(spaceUri: string, cid: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM spaces_blobs WHERE space_uri = ? AND cid = ?`)
      .bind(spaceUri, cid)
      .run();
  }

  async findOrphanBlobs(
    spaceUri: string,
    cutoff: number,
    limit: number
  ): Promise<BlobMetaRow[]> {
    if (!this.config) return [];
    // Gather candidate blobs older than cutoff, then filter out any whose CID
    // appears in any record JSON in this space. We use a cheap substring probe
    // (LIKE) per collection — false positives are OK because an orphan that
    // survives GC just gets collected next cycle; false negatives (deleting
    // a referenced blob) would be a bug, and substring search over the full
    // CID is safe enough for that.
    const { results } = await this.db
      .prepare(
        `SELECT * FROM spaces_blobs
         WHERE space_uri = ? AND created_at < ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .bind(spaceUri, cutoff, limit)
      .all<any>();
    const candidates = results.map(mapBlobMetaRow);
    if (candidates.length === 0) return [];

    const tables: string[] = [];
    for (const [short, colConfig] of Object.entries(this.config.collections)) {
      if (colConfig.allowInSpaces === false) continue;
      tables.push(spacesRecordsTableName(short));
    }

    const orphans: BlobMetaRow[] = [];
    for (const blob of candidates) {
      let referenced = false;
      const pattern = `%${blob.cid}%`;
      for (const table of tables) {
        try {
          const row = await this.db
            .prepare(
              `SELECT 1 FROM ${table} WHERE space_uri = ? AND record LIKE ? LIMIT 1`
            )
            .bind(spaceUri, pattern)
            .first<any>();
          if (row) {
            referenced = true;
            break;
          }
        } catch {
          // table missing — ignore
        }
      }
      if (!referenced) orphans.push(blob);
    }
    return orphans;
  }
}
