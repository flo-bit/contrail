import type {
  ContrailConfig,
  Database,
  IngestEvent,
  RelationConfig,
  ResolvedContrailConfig,
  Statement,
} from "../types";
import {
  countColumnName,
  getNestedValue,
  getRelationField,
  groupedCountColumnName,
  recordsTableName,
  shortNameForNsid,
} from "../types";
import { getDialect, isPostgresDialect } from "../dialect";
import { activeHiddenSql, visibleRecordSql } from "../moderation";

interface InboundRelation {
  /** Short name of the parent collection. */
  parentCollection: string;
  relationName: string;
  rel: RelationConfig;
}

/** Find relations that target the given short-named child collection. */
function getInboundRelations(
  config: ContrailConfig,
  childShortName: string,
): InboundRelation[] {
  const results: InboundRelation[] = [];
  for (const [colName, colConfig] of Object.entries(config.collections)) {
    for (const [relName, rel] of Object.entries(colConfig.relations ?? {})) {
      if (rel.collection === childShortName) {
        results.push({ parentCollection: colName, relationName: relName, rel });
      }
    }
  }
  return results;
}

/**
 * Collect recount targets from a single event into a shared map.
 * The map is keyed by `parentCollection:relationName:targetValue` to deduplicate
 * across the entire batch — so 50 RSVPs to the same event produce one recount, not 50.
 */
export type CountTarget = {
  parentCollection: string;
  relationName: string;
  rel: RelationConfig;
  targetValue: string;
};

function addCountTarget(
  targets: Map<string, CountTarget>,
  target: CountTarget,
): void {
  const key = `${target.parentCollection}:${target.relationName}:${target.targetValue}`;
  if (!targets.has(key)) targets.set(key, target);
}

export function collectCountTargets(
  event: IngestEvent,
  config: ContrailConfig,
  existingRecordJson: string | null,
  targets: Map<string, CountTarget>,
  getRecord?: () => unknown,
): void {
  const childShort = shortNameForNsid(config, event.collection);
  if (!childShort) return;
  const inbound = getInboundRelations(config, childShort);
  if (inbound.length === 0) return;

  const record = getRecord
    ? getRecord()
    : event.record
      ? JSON.parse(event.record)
      : null;
  const existingRecord = existingRecordJson
    ? JSON.parse(existingRecordJson)
    : null;

  for (const { parentCollection, relationName, rel } of inbound) {
    if (rel.count === false) continue;

    const field = getRelationField(rel);

    const values: string[] = [];
    if (record) {
      const t = getNestedValue(record, field);
      if (t) values.push(t);
    }
    if (existingRecord) {
      const t = getNestedValue(existingRecord, field);
      if (t && !values.includes(t)) values.push(t);
    }

    for (const targetValue of values) {
      addCountTarget(targets, {
        parentCollection,
        relationName,
        rel,
        targetValue,
      });
    }
  }
}

/** Recount a newly arriving parent against children that may already exist. */
export function collectParentCountTargets(
  event: IngestEvent,
  config: ContrailConfig,
  targets: Map<string, CountTarget>,
): void {
  if (event.operation === "delete") return;
  const parentCollection = shortNameForNsid(config, event.collection);
  if (!parentCollection) return;

  for (const [relationName, rel] of Object.entries(
    config.collections[parentCollection]?.relations ?? {},
  )) {
    if (rel.count === false) continue;
    addCountTarget(targets, {
      parentCollection,
      relationName,
      rel,
      targetValue: rel.match === "did" ? event.did : event.uri,
    });
  }
}

/**
 * Build deduplicated count UPDATE statements from collected targets.
 * One UPDATE per unique parent+relation+target, regardless of how many
 * events in the batch affected that target.
 */
export function buildBatchCountStatements(
  db: Database,
  config: ContrailConfig,
  targets: Map<string, CountTarget>,
): Statement[] {
  const statements: Statement[] = [];

  for (const {
    parentCollection,
    relationName,
    rel,
    targetValue,
  } of targets.values()) {
    const field = getRelationField(rel);
    const matchColumn = rel.match === "did" ? "did" : "uri";
    const childTable = recordsTableName(rel.collection);
    const parentTable = recordsTableName(parentCollection);

    const setClauses: string[] = [];
    const setBindings: (string | number)[] = [];

    const dialect = getDialect(db);
    const fieldFilter = {
      expr: (alias: string) => dialect.jsonExtract(`${alias}.record`, field),
      value: targetValue,
    };

    // Total count
    const totalCol = countColumnName(rel.collection);
    const total = visibleChildCountSql(db, childTable, rel.countDistinct, [
      fieldFilter,
    ]);
    setClauses.push(`${totalCol} = ${total.sql}`);
    setBindings.push(...total.bindings);

    // Grouped counts — column names are `count_<child-short>_<group-key>`; match
    // against the group's full token value in the record.
    if (rel.groupBy) {
      const mapping = (config as ResolvedContrailConfig)._resolved?.relations[
        parentCollection
      ]?.[relationName];
      if (mapping?.groups) {
        for (const [groupKey, fullToken] of Object.entries(mapping.groups)) {
          const groupCol = groupedCountColumnName(rel.collection, groupKey);
          const groupBy = rel.groupBy;
          const grouped = visibleChildCountSql(
            db,
            childTable,
            rel.countDistinct,
            [
              fieldFilter,
              {
                expr: (alias) =>
                  dialect.jsonExtract(`${alias}.record`, groupBy),
                value: fullToken,
              },
            ],
          );
          setClauses.push(`${groupCol} = ${grouped.sql}`);
          setBindings.push(...grouped.bindings);
        }
      }
    }

    if (setClauses.length > 0) {
      statements.push(
        db
          .prepare(
            `UPDATE ${parentTable} SET ${setClauses.join(", ")} WHERE ${matchColumn} = ?`,
          )
          .bind(...setBindings, targetValue),
      );
    }
  }

  return statements;
}

/** Above this many `moderation_hidden` rows, never drive a count from them. */
const HIDDEN_DRIVE_CAP = 10_000;

/** Public child count: stored counts exclude hidden children, and moderation
 * visibility changes recount affected parents.
 *
 * Probing visibility per child costs a row fetch and two index lookups per
 * child, which is expensive for parents with many children. So when there are
 * more children than hidden rows, count the index-only total and subtract the
 * hidden children found by driving from `moderation_hidden` instead. Distinct
 * counts cannot be subtracted and only skip the probes when nothing is hidden.
 * Each filter value is bound once; subqueries read it from `q`. */
function visibleChildCountSql(
  db: Database,
  childTable: string,
  countDistinct: string | undefined,
  filters: Array<{ expr: (alias: string) => string; value: string }>,
): { sql: string; bindings: string[] } {
  const pg = isPostgresDialect(getDialect(db));
  // SQLite: unary `+` stops the planner from using the relation index when
  // driving from hidden rows, so it probes children by did/uri instead.
  const where = (alias: string, drive = false) =>
    filters
      .map((f, i) => `${drive && !pg ? "+" : ""}${f.expr(alias)} = q.v${i}`)
      .join(" AND ");
  // PostgreSQL needs a parameter type; on SQLite a TEXT affinity would stop
  // the relation's expression index from matching.
  const params = `(SELECT ${filters.map((_, i) => `${pg ? "CAST(? AS TEXT)" : "?"} AS v${i}`).join(", ")}) p`;
  // Keep `q` a materialized row: flattening would evaluate t/h per reference.
  const fence = pg ? "OFFSET 0" : "LIMIT -1 OFFSET 0";
  const bindings = filters.map((f) => f.value);
  const columns = filters.map((_, i) => `p.v${i}`).join(", ");
  if (countDistinct) {
    const distinctExpr = ["uri", "did", "rkey"].includes(countDistinct)
      ? `mc.${countDistinct}`
      : getDialect(db).jsonExtract("mc.record", countDistinct);
    const anyHidden = `EXISTS (SELECT 1 FROM moderation_hidden h WHERE ${activeHiddenSql("h")})`;
    return {
      sql: `(SELECT (SELECT COUNT(DISTINCT ${distinctExpr}) FROM ${childTable} mc
        WHERE ${where("mc")} AND (NOT ${anyHidden} OR ${visibleRecordSql("mc")}))
        FROM (SELECT ${columns} FROM ${params}) q)`,
      bindings,
    };
  }
  const join = pg ? "JOIN" : "CROSS JOIN"; // SQLite: CROSS JOIN fixes join order
  const perRow = `(SELECT COUNT(*) FROM ${childTable} mc WHERE ${where("mc")} AND ${visibleRecordSql("mc")})`;
  const hiddenChildren = `(SELECT COUNT(*) FROM (
      SELECT c.uri FROM moderation_hidden mh ${join} ${childTable} c ON c.did = mh.subject
      WHERE mh.cid = '' AND ${activeHiddenSql("mh")} AND ${where("c", true)}
      UNION
      SELECT c.uri FROM moderation_hidden mh ${join} ${childTable} c
        ON c.uri = mh.subject AND (mh.cid = '' OR mh.cid = c.cid)
      WHERE ${activeHiddenSql("mh")} AND ${where("c", true)}
    ) hidden_children)`;
  return {
    sql: `(SELECT CASE WHEN q.h >= ${HIDDEN_DRIVE_CAP} OR q.t <= q.h THEN ${perRow}
        ELSE q.t - ${hiddenChildren} END
      FROM (SELECT ${columns},
        (SELECT COUNT(*) FROM ${childTable} mc WHERE ${filters.map((f, i) => `${f.expr("mc")} = p.v${i}`).join(" AND ")}) AS t,
        (SELECT COUNT(*) FROM (SELECT 1 FROM moderation_hidden LIMIT ${HIDDEN_DRIVE_CAP}) x) AS h
        FROM ${params} ${fence}) q)`,
    bindings,
  };
}

/** Recount every parent the given child records point at, under current
 * moderation visibility. Used when a child's visibility changes. */
export function childRecountStatements(
  db: Database,
  config: ContrailConfig,
  childShort: string,
  records: Array<{ record: unknown }>,
): Statement[] {
  const targets = new Map<string, CountTarget>();
  for (const { parentCollection, relationName, rel } of getInboundRelations(
    config,
    childShort,
  )) {
    if (rel.count === false) continue;
    for (const row of records) {
      const record =
        typeof row.record === "string" ? JSON.parse(row.record) : row.record;
      const targetValue = record
        ? getNestedValue(record, getRelationField(rel))
        : null;
      if (typeof targetValue === "string" && targetValue)
        addCountTarget(targets, {
          parentCollection,
          relationName,
          rel,
          targetValue,
        });
    }
  }
  return buildBatchCountStatements(db, config, targets);
}

export function buildRelationRebuildSpec(
  config: ContrailConfig,
  dialect: ReturnType<typeof getDialect>,
  parentShort: string,
  relationName: string,
  relation: RelationConfig,
) {
  const childTable = recordsTableName(relation.collection);
  const childTarget = dialect.jsonExtract(
    "child.record",
    getRelationField(relation),
  );
  const parentTarget = relation.match === "did" ? "did" : "uri";
  const distinctExpression = relation.countDistinct
    ? ["uri", "did", "rkey"].includes(relation.countDistinct)
      ? `child.${relation.countDistinct}`
      : dialect.jsonExtract("child.record", relation.countDistinct)
    : null;
  const totalCount = distinctExpression
    ? `COUNT(DISTINCT ${distinctExpression})`
    : "COUNT(*)";
  const totalColumn = countColumnName(relation.collection);
  const projections = [`${totalCount} AS ${totalColumn}`];
  const columns = [totalColumn];
  const bindings: string[] = [];

  const mapping = (config as ResolvedContrailConfig)._resolved?.relations[
    parentShort
  ]?.[relationName];
  if (relation.groupBy && mapping?.groups) {
    const childGroup = dialect.jsonExtract("child.record", relation.groupBy);
    for (const [groupKey, token] of Object.entries(mapping.groups)) {
      const column = groupedCountColumnName(relation.collection, groupKey);
      const groupedCount = distinctExpression
        ? `COUNT(DISTINCT CASE WHEN ${childGroup} = ? THEN ${distinctExpression} END)`
        : `SUM(CASE WHEN ${childGroup} = ? THEN 1 ELSE 0 END)`;
      projections.push(`${groupedCount} AS ${column}`);
      columns.push(column);
      bindings.push(token);
    }
  }

  return {
    childTable,
    childTarget,
    parentTarget,
    projections,
    columns,
    bindings,
  };
}

/** Count column descriptor. `type` is the identifier returned in API responses and
 *  accepted in countFilters — we keep the full record token for grouped counts so
 *  callers pass e.g. "community.lexicon.calendar.rsvp#going" and filter/hydrate by it. */
export function getCountColumns(
  config: ContrailConfig,
  shortName: string,
): { type: string; column: string }[] {
  const colConfig = config.collections[shortName];
  if (!colConfig?.relations) return [];
  const columns: { type: string; column: string }[] = [];
  const relMap =
    (config as ResolvedContrailConfig)._resolved?.relations[shortName] ?? {};

  for (const [relName, rel] of Object.entries(colConfig.relations)) {
    if (rel.count === false) continue;
    // Total: identifier is the child's short name; column is `count_<child-short>`.
    columns.push({
      type: rel.collection,
      column: countColumnName(rel.collection),
    });
    const mapping = relMap[relName];
    if (mapping) {
      for (const [groupKey, fullToken] of Object.entries(mapping.groups)) {
        // Grouped: identifier is the full record token (stable across deployments);
        // column is `count_<child-short>_<group-key>`.
        columns.push({
          type: fullToken,
          column: groupedCountColumnName(rel.collection, groupKey),
        });
      }
    }
  }
  return columns;
}

/** For a given "count type" (short name or full group token), return the DB column. */
export function countColumnForType(
  config: ContrailConfig,
  shortName: string,
  type: string,
): string | null {
  for (const col of getCountColumns(config, shortName)) {
    if (col.type === type) return col.column;
  }
  return null;
}
