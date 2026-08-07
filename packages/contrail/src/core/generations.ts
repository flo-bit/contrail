import type { Database } from "./types";
import { getDialect } from "./dialect";
import type { SourcePosition } from "./sources";
import type { BootstrapVerificationReport } from "./verification";

const ACTIVE_POINTER_ID = 1;

export interface GenerationTuple {
  /** Stable immutable deployment generation ID. */
  id: string;
  /** Digest or immutable version for the executable artifact. */
  codeDigest: string;
  /** Digest of the projection/lexicon definition. */
  definitionDigest: string;
  /** Platform-owned locator for this generation's dedicated database. */
  databaseLocator: string;
  schemaVersion: number;
}

export interface GenerationReadiness {
  through: SourcePosition;
  verification: BootstrapVerificationReport;
}

export type GenerationLifecycleState =
  | "candidate"
  | "ready"
  | "active"
  | "retained"
  | "retired";

export interface GenerationRecord {
  tuple: GenerationTuple;
  readiness: GenerationReadiness | null;
  state: GenerationLifecycleState;
  createdAt: number;
  readyAt: number | null;
  lastActivatedAt: number | null;
  retiredAt: number | null;
}

export interface GenerationActivation {
  previous: GenerationRecord | null;
  active: GenerationRecord;
}

interface GenerationRow {
  id: string;
  code_digest: string;
  definition_digest: string;
  database_locator: string;
  schema_version: number | string;
  readiness_json: string | null;
  created_at: number | string;
  ready_at: number | string | null;
  last_activated_at: number | string | null;
  retired_at: number | string | null;
  active_id: string | null;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must contain 1-${maximum} characters`);
  }
  return value;
}

function timestamp(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid durable generation timestamp");
  }
  return parsed;
}

function validateTuple(tuple: GenerationTuple): GenerationTuple {
  boundedText(tuple.id, "generation id", 128);
  boundedText(tuple.codeDigest, "code digest", 256);
  boundedText(tuple.definitionDigest, "definition digest", 256);
  boundedText(tuple.databaseLocator, "database locator", 2_048);
  if (!Number.isSafeInteger(tuple.schemaVersion) || tuple.schemaVersion < 1) {
    throw new TypeError("schemaVersion must be a positive safe integer");
  }
  return tuple;
}

function validateReadiness(readiness: GenerationReadiness): GenerationReadiness {
  const { through, verification } = readiness;
  boundedText(through.source, "readiness source", 128);
  boundedText(through.epoch, "readiness epoch", 256);
  boundedText(through.cursor, "readiness cursor", 2_048);
  if (!verification.ok) {
    throw new Error("A failed bootstrap verification cannot become ready");
  }
  if (
    !Number.isSafeInteger(verification.verifiedAt) ||
    verification.verifiedAt < 0 ||
    !Array.isArray(verification.checks) ||
    !verification.checks.every(
      (item) =>
        item &&
        typeof item.name === "string" &&
        item.name.length > 0 &&
        item.name.length <= 256 &&
        item.ok === true &&
        Number.isSafeInteger(item.failures) &&
        item.failures === 0,
    )
  ) {
    throw new Error("Generation readiness contains malformed verification");
  }
  return readiness;
}

function parseReadiness(serialized: string): GenerationReadiness {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Durable generation readiness is not valid JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Durable generation readiness is malformed");
  }
  return validateReadiness(value as GenerationReadiness);
}

function record(row: GenerationRow): GenerationRecord {
  const tuple = validateTuple({
    id: row.id,
    codeDigest: row.code_digest,
    definitionDigest: row.definition_digest,
    databaseLocator: row.database_locator,
    schemaVersion: Number(row.schema_version),
  });
  const retiredAt = timestamp(row.retired_at);
  const lastActivatedAt = timestamp(row.last_activated_at);
  const readiness = row.readiness_json
    ? parseReadiness(row.readiness_json)
    : null;
  const state: GenerationLifecycleState =
    retiredAt !== null
      ? "retired"
      : row.active_id === row.id
        ? "active"
        : readiness === null
          ? "candidate"
          : lastActivatedAt === null
            ? "ready"
            : "retained";
  return {
    tuple,
    readiness,
    state,
    createdAt: timestamp(row.created_at)!,
    readyAt: timestamp(row.ready_at),
    lastActivatedAt,
    retiredAt,
  };
}

function sameTuple(left: GenerationTuple, right: GenerationTuple): boolean {
  return (
    left.id === right.id &&
    left.codeDigest === right.codeDigest &&
    left.definitionDigest === right.definitionDigest &&
    left.databaseLocator === right.databaseLocator &&
    left.schemaVersion === right.schemaVersion
  );
}

/** Initialize a small control-plane registry. This database is separate from
 * candidate projection databases and stores no record bodies or source errors. */
export async function initGenerationRegistry(db: Database): Promise<void> {
  const bigint = getDialect(db).bigintType;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS contrail_generations (
        id TEXT PRIMARY KEY,
        code_digest TEXT NOT NULL,
        definition_digest TEXT NOT NULL,
        database_locator TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        readiness_json TEXT,
        created_at ${bigint} NOT NULL,
        ready_at ${bigint},
        last_activated_at ${bigint},
        retired_at ${bigint}
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS contrail_generation_activation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        generation_id TEXT,
        activated_at ${bigint},
        FOREIGN KEY (generation_id) REFERENCES contrail_generations(id)
      )`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO contrail_generation_activation (id, generation_id)
       VALUES (?, NULL) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(ACTIVE_POINTER_ID)
    .run();
}

/** Durable compare-and-swap registry for complete deployment tuples.
 *
 * Request routing must resolve this one active pointer; this API deliberately
 * exposes no percentage split between independent generation databases. */
export class DatabaseGenerationRegistry {
  constructor(private readonly db: Database) {}

  async registerCandidate(tuple: GenerationTuple): Promise<GenerationRecord> {
    validateTuple(tuple);
    await this.db
      .prepare(
        `INSERT INTO contrail_generations
         (id, code_digest, definition_digest, database_locator, schema_version,
          created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        tuple.id,
        tuple.codeDigest,
        tuple.definitionDigest,
        tuple.databaseLocator,
        tuple.schemaVersion,
        Date.now(),
      )
      .run();
    const stored = await this.get(tuple.id);
    if (!stored || !sameTuple(stored.tuple, tuple)) {
      throw new Error(`Generation ${tuple.id} already names another tuple`);
    }
    return stored;
  }

  async markReady(
    id: string,
    readiness: GenerationReadiness,
  ): Promise<GenerationRecord> {
    boundedText(id, "generation id", 128);
    validateReadiness(readiness);
    const serialized = JSON.stringify(readiness);
    await this.db
      .prepare(
        `UPDATE contrail_generations
         SET readiness_json = ?, ready_at = ?
         WHERE id = ? AND readiness_json IS NULL AND retired_at IS NULL`,
      )
      .bind(serialized, Date.now(), id)
      .run();
    const stored = await this.get(id);
    if (!stored) throw new Error(`Unknown generation ${id}`);
    if (stored.state === "retired") {
      throw new Error(`Retired generation ${id} cannot become ready`);
    }
    if (JSON.stringify(stored.readiness) !== serialized) {
      throw new Error(`Generation ${id} already has different readiness proof`);
    }
    return stored;
  }

  async get(id: string): Promise<GenerationRecord | null> {
    boundedText(id, "generation id", 128);
    const row = await this.db
      .prepare(
        `SELECT generation.*, activation.generation_id AS active_id
         FROM contrail_generations AS generation
         LEFT JOIN contrail_generation_activation AS activation
           ON activation.id = ?
         WHERE generation.id = ?`,
      )
      .bind(ACTIVE_POINTER_ID, id)
      .first<GenerationRow>();
    return row ? record(row) : null;
  }

  async active(): Promise<GenerationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT generation.*, activation.generation_id AS active_id
         FROM contrail_generation_activation AS activation
         JOIN contrail_generations AS generation
           ON generation.id = activation.generation_id
         WHERE activation.id = ?`,
      )
      .bind(ACTIVE_POINTER_ID)
      .first<GenerationRow>();
    return row ? record(row) : null;
  }

  /** Atomically switch the complete tuple if the caller still sees the expected
   * active generation. The old tuple remains ready for explicit rollback. */
  async activate(
    candidateId: string,
    expectedActiveId: string | null,
  ): Promise<GenerationActivation> {
    boundedText(candidateId, "candidate generation id", 128);
    if (expectedActiveId !== null) {
      boundedText(expectedActiveId, "expected generation id", 128);
    }
    const previous = await this.active();
    if ((previous?.tuple.id ?? null) !== expectedActiveId) {
      throw new Error("Active generation changed before activation");
    }

    const switched = await this.db
      .prepare(
        `UPDATE contrail_generation_activation
         SET generation_id = ?, activated_at = ?
         WHERE id = ?
           AND ((generation_id = ?) OR
                (generation_id IS NULL AND CAST(? AS TEXT) IS NULL))
           AND EXISTS (
             SELECT 1 FROM contrail_generations
             WHERE id = ? AND readiness_json IS NOT NULL AND retired_at IS NULL
           )
         RETURNING generation_id`,
      )
      .bind(
        candidateId,
        Date.now(),
        ACTIVE_POINTER_ID,
        expectedActiveId,
        expectedActiveId,
        candidateId,
      )
      .first<{ generation_id: string }>();
    if (switched?.generation_id !== candidateId) {
      const candidate = await this.get(candidateId);
      if (!candidate) throw new Error(`Unknown generation ${candidateId}`);
      if (candidate.state === "candidate") {
        throw new Error(`Generation ${candidateId} is not ready`);
      }
      if (candidate.state === "retired") {
        throw new Error(`Generation ${candidateId} is retired`);
      }
      throw new Error("Active generation changed during activation");
    }

    // The pointer switch above is the authoritative atomic action. This field
    // only distinguishes retained generations in operator listings, so a
    // bookkeeping failure must not misreport a successful activation as failed.
    try {
      await this.db
        .prepare(
          `UPDATE contrail_generations SET last_activated_at = ?
           WHERE id = ?`,
        )
        .bind(Date.now(), candidateId)
        .run();
    } catch {
      // Best-effort metadata; active() still resolves the switched tuple.
    }
    const activated = await this.get(candidateId);
    if (!activated) throw new Error("Activated generation could not be resolved");
    // A later concurrent activation may already have moved the pointer again;
    // the successful CAS still activated this tuple at its linearization point.
    return { previous, active: { ...activated, state: "active" } };
  }

  async retire(id: string): Promise<GenerationRecord> {
    boundedText(id, "generation id", 128);
    await this.db
      .prepare(
        `UPDATE contrail_generations SET retired_at = ?
         WHERE id = ? AND retired_at IS NULL
           AND id <> COALESCE(
             (SELECT generation_id FROM contrail_generation_activation WHERE id = ?),
             ''
           )`,
      )
      .bind(Date.now(), id, ACTIVE_POINTER_ID)
      .run();
    const stored = await this.get(id);
    if (!stored) throw new Error(`Unknown generation ${id}`);
    if (stored.state === "active") {
      throw new Error(`Active generation ${id} cannot be retired`);
    }
    if (stored.state !== "retired") {
      throw new Error(`Generation ${id} could not be retired`);
    }
    return stored;
  }

  async list(): Promise<GenerationRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT generation.*, activation.generation_id AS active_id
         FROM contrail_generations AS generation
         LEFT JOIN contrail_generation_activation AS activation
           ON activation.id = ?
         ORDER BY generation.created_at DESC, generation.id`,
      )
      .bind(ACTIVE_POINTER_ID)
      .all<GenerationRow>();
    return (rows.results ?? []).map(record);
  }
}
