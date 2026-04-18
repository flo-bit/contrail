import type { ContrailConfig, Database, RelationConfig, ResolvedContrailConfig } from "../types";
import {
  shortNameForNsid,
  spacesRecordsTableName,
  countColumnName,
  groupedCountColumnName,
  getRelationField,
  getNestedValue,
} from "../types";
import { getDialect } from "../dialect";
import type {
  AppPolicy,
  CollectionCount,
  CreateInviteInput,
  InviteKind,
  InviteRow,
  ListOptions,
  ListResult,
  ListSpacesOptions,
  MemberPerm,
  SpaceMemberRow,
  SpaceRow,
  StorageAdapter,
  StoredRecord,
} from "./types";
import { buildRecordUri } from "./uri";

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

function mapSpaceRow(row: any): SpaceRow {
  return {
    uri: row.uri,
    ownerDid: row.owner_did,
    type: row.type,
    key: row.key,
    serviceDid: row.service_did,
    memberListRef: row.member_list_ref ?? null,
    appPolicyRef: row.app_policy_ref ?? null,
    appPolicy: parseJson<AppPolicy>(row.app_policy),
    createdAt: toNum(row.created_at),
    deletedAt: row.deleted_at == null ? null : toNum(row.deleted_at),
  };
}

function mapMemberRow(row: any): SpaceMemberRow {
  return {
    spaceUri: row.space_uri,
    did: row.did,
    perms: row.perms as MemberPerm,
    addedAt: toNum(row.added_at),
    addedBy: row.added_by ?? null,
  };
}

function mapInviteRow(row: any): InviteRow {
  return {
    tokenHash: row.token_hash,
    spaceUri: row.space_uri,
    kind: (row.kind ?? "join") as InviteKind,
    perms: row.perms,
    expiresAt: row.expires_at == null ? null : toNum(row.expires_at),
    maxUses: row.max_uses == null ? null : Number(row.max_uses),
    usedCount: Number(row.used_count),
    createdBy: row.created_by,
    createdAt: toNum(row.created_at),
    revokedAt: row.revoked_at == null ? null : toNum(row.revoked_at),
    note: row.note ?? null,
  };
}

/** Row mapper for per-collection spaces_records_<short> tables.
 *  `collection` is injected by the caller (known from the table name). */
function mapRecordRow(row: any, collection: string): StoredRecord {
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

export class HostedAdapter implements StorageAdapter {
  constructor(
    private readonly db: Database,
    private readonly config?: ContrailConfig
  ) {}

  /** Resolve the per-collection spaces table name, or throw if the collection
   *  isn't configured (and therefore has no table). */
  private tableFor(collection: string): string {
    if (!this.config) {
      throw new Error(
        `HostedAdapter: config not provided; cannot resolve table for collection ${collection}`
      );
    }
    const short = shortNameForNsid(this.config, collection);
    if (!short) {
      throw new Error(
        `HostedAdapter: collection ${collection} is not configured in this deployment`
      );
    }
    return spacesRecordsTableName(short);
  }

  async createSpace(space: Omit<SpaceRow, "createdAt" | "deletedAt">): Promise<SpaceRow> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO spaces (uri, owner_did, type, key, service_did, member_list_ref, app_policy_ref, app_policy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        space.uri,
        space.ownerDid,
        space.type,
        space.key,
        space.serviceDid,
        space.memberListRef,
        space.appPolicyRef,
        space.appPolicy ? JSON.stringify(space.appPolicy) : null,
        now
      )
      .run();
    return { ...space, createdAt: now, deletedAt: null };
  }

  async getSpace(spaceUri: string): Promise<SpaceRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM spaces WHERE uri = ? AND deleted_at IS NULL`)
      .bind(spaceUri)
      .first<any>();
    return row ? mapSpaceRow(row) : null;
  }

  async listSpaces(options: ListSpacesOptions): Promise<{ spaces: SpaceRow[]; cursor?: string }> {
    const limit = Math.min(options.limit ?? 50, 200);
    const clauses: string[] = ["s.deleted_at IS NULL"];
    const params: any[] = [];
    let join = "";

    if (options.type) {
      clauses.push("s.type = ?");
      params.push(options.type);
    }
    if (options.ownerDid) {
      clauses.push("s.owner_did = ?");
      params.push(options.ownerDid);
    }
    if (options.memberDid) {
      join = "JOIN spaces_members m ON m.space_uri = s.uri";
      clauses.push("m.did = ?");
      params.push(options.memberDid);
    }
    if (options.cursor) {
      clauses.push("s.created_at < ?");
      params.push(Number(options.cursor));
    }

    const sql = `SELECT s.* FROM spaces s ${join}
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.created_at DESC
      LIMIT ?`;
    params.push(limit + 1);

    const { results } = await this.db.prepare(sql).bind(...params).all<any>();
    const spaces = results.map(mapSpaceRow);
    let cursor: string | undefined;
    if (spaces.length > limit) {
      const next = spaces.pop()!;
      cursor = String(next.createdAt);
    }
    return { spaces, cursor };
  }

  async deleteSpace(spaceUri: string): Promise<void> {
    await this.db
      .prepare(`UPDATE spaces SET deleted_at = ? WHERE uri = ?`)
      .bind(Date.now(), spaceUri)
      .run();
  }

  async transferOwnership(spaceUri: string, newOwnerDid: string): Promise<SpaceRow | null> {
    await this.db
      .prepare(`UPDATE spaces SET owner_did = ? WHERE uri = ? AND deleted_at IS NULL`)
      .bind(newOwnerDid, spaceUri)
      .run();
    return this.getSpace(spaceUri);
  }

  async updateSpaceAppPolicy(spaceUri: string, appPolicy: AppPolicy): Promise<void> {
    await this.db
      .prepare(`UPDATE spaces SET app_policy = ? WHERE uri = ?`)
      .bind(JSON.stringify(appPolicy), spaceUri)
      .run();
  }

  async addMember(spaceUri: string, did: string, perms: MemberPerm, addedBy: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO spaces_members (space_uri, did, perms, added_at, added_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (space_uri, did) DO UPDATE SET perms = excluded.perms`
      )
      .bind(spaceUri, did, perms, Date.now(), addedBy)
      .run();
  }

  async removeMember(spaceUri: string, did: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM spaces_members WHERE space_uri = ? AND did = ?`)
      .bind(spaceUri, did)
      .run();
  }

  async getMember(spaceUri: string, did: string): Promise<SpaceMemberRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM spaces_members WHERE space_uri = ? AND did = ?`)
      .bind(spaceUri, did)
      .first<any>();
    return row ? mapMemberRow(row) : null;
  }

  async listMembers(spaceUri: string): Promise<SpaceMemberRow[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM spaces_members WHERE space_uri = ? ORDER BY added_at ASC`)
      .bind(spaceUri)
      .all<any>();
    return results.map(mapMemberRow);
  }

  async createInvite(input: CreateInviteInput): Promise<InviteRow> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO spaces_invites (token_hash, space_uri, kind, perms, expires_at, max_uses, used_count, created_by, created_at, note)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .bind(
        input.tokenHash,
        input.spaceUri,
        input.kind,
        input.perms,
        input.expiresAt,
        input.maxUses,
        input.createdBy,
        now,
        input.note
      )
      .run();
    return {
      tokenHash: input.tokenHash,
      spaceUri: input.spaceUri,
      kind: input.kind,
      perms: input.perms,
      expiresAt: input.expiresAt,
      maxUses: input.maxUses,
      usedCount: 0,
      createdBy: input.createdBy,
      createdAt: now,
      revokedAt: null,
      note: input.note,
    };
  }

  async getInvite(tokenHash: string): Promise<InviteRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM spaces_invites WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<any>();
    return row ? mapInviteRow(row) : null;
  }

  async listInvites(
    spaceUri: string,
    options: { includeRevoked?: boolean } = {}
  ): Promise<InviteRow[]> {
    const sql = options.includeRevoked
      ? `SELECT * FROM spaces_invites WHERE space_uri = ? ORDER BY created_at DESC`
      : `SELECT * FROM spaces_invites WHERE space_uri = ? AND revoked_at IS NULL ORDER BY created_at DESC`;
    const { results } = await this.db.prepare(sql).bind(spaceUri).all<any>();
    return results.map(mapInviteRow);
  }

  async revokeInvite(tokenHash: string): Promise<boolean> {
    const res = await this.db
      .prepare(`UPDATE spaces_invites SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
      .bind(Date.now(), tokenHash)
      .run();
    const changes = (res as any)?.changes ?? (res as any)?.meta?.changes ?? 0;
    return Number(changes) > 0;
  }

  async redeemInvite(tokenHash: string, now: number): Promise<InviteRow | null> {
    // Atomic: increment used_count only if the invite is usable right now AND
    // its kind allows redemption (read-only tokens cannot be consumed for membership).
    const res = await this.db
      .prepare(
        `UPDATE spaces_invites
         SET used_count = used_count + 1
         WHERE token_hash = ?
           AND kind IN ('join', 'read-join')
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND (max_uses IS NULL OR used_count < max_uses)`
      )
      .bind(tokenHash, now)
      .run();
    const changes = (res as any)?.changes ?? (res as any)?.meta?.changes ?? 0;
    if (Number(changes) === 0) return null;

    const row = await this.db
      .prepare(`SELECT * FROM spaces_invites WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<any>();
    return row ? mapInviteRow(row) : null;
  }

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
  private async recountParentsForSpace(
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
}
