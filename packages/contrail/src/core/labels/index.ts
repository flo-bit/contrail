import type { Database } from "../types";
import { isPostgresDialect, type SqlDialect } from "../dialect";
import { batchedInQuery, type FormattedRecord } from "../router/helpers";
import type { ProfileEntry } from "../router/profiles";

/** A labeler the operator wants contrail to track. */
export interface LabelerSource {
  /** Labeler DID — `did:plc:...` or `did:web:...`. */
  did: string;
  /** Override the service endpoint resolution. Otherwise resolved from the
   *  DID doc's `service[id="#atproto_labeler"].serviceEndpoint`. */
  endpoint?: string;
  /** Backfill from `cursor=0` on first sight. Defaults to true. Set false
   *  for "start from now" — useful for very chatty labelers. */
  backfill?: boolean;
  /** Records-backed moderator source; never connect a labeler WebSocket. */
  records?: boolean;
  enforce?: boolean;
  values?: string[];
  subjects?: "known";
}

export interface LabelsConfig {
  /** Labelers to subscribe to and index. */
  sources: LabelerSource[];
  /** DIDs honored when the caller sends no `atproto-accept-labelers` /
   *  `?labelers=`. Defaults to every entry in `sources`. Set `[]` for
   *  opt-in-only — clients see no labels unless they ask. */
  defaults?: string[];
  /** Per-request cap. Default: 20 (matches Bluesky). */
  maxPerRequest?: number;
}

export const DEFAULT_LABELS_MAX_PER_REQUEST = 20;

/** A single label as stored. Matches `com.atproto.label.defs#label`. */
export interface LabelRow {
  /** Issuing labeler DID. */
  src: string;
  /** Subject — at-URI for record labels, plain DID for account labels. */
  uri: string;
  /** Label value — kebab-case, ≤128 bytes per spec. */
  val: string;
  /** Optional CID pin to a specific record version. */
  cid: string | null;
  /** When true, retracts a previously-emitted label for the same (src, uri, val). */
  neg: boolean;
  /** Expiry, unix seconds. Past this, hydration drops the row. */
  exp: number | null;
  /** Creation timestamp, unix milliseconds — what we collapse on. */
  cts: number;
  /** Raw signature bytes. Stored when present so we can re-emit later;
   *  not verified in v1. */
  sig: Uint8Array | null;
}

/** Per-labeler state row — endpoint cache and last-seen seq cursor. */
export interface LabelerCursorRow {
  did: string;
  cursor: number;
  endpoint: string | null;
  resolved_at: number | null;
}

/** DDL for the labels module. Single `labels` table covers record-level
 *  (uri starts with `at://`) and account-level (uri is a bare DID) entries —
 *  the spec collapses both into the same row shape. `labeler_cursors`
 *  mirrors the role of the singleton `cursor` table for jetstream, but
 *  per-labeler. */
export function buildLabelsSchema(dialect: SqlDialect): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS labels (
       src TEXT NOT NULL,
       uri TEXT NOT NULL,
       val TEXT NOT NULL,
       cid TEXT,
       neg INTEGER NOT NULL DEFAULT 0,
       exp ${dialect.bigintType},
       cts ${dialect.bigintType} NOT NULL,
       sig ${isPostgresDialect(dialect) ? "BYTEA" : "BLOB"},
       PRIMARY KEY (src, uri, val, cts)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_labels_uri ON labels(uri)`,
    `CREATE INDEX IF NOT EXISTS idx_labels_src_cts ON labels(src, cts DESC)`,
    `CREATE TABLE IF NOT EXISTS labeler_cursors (
       did TEXT PRIMARY KEY,
       cursor ${dialect.bigintType} NOT NULL DEFAULT 0,
       endpoint TEXT,
       resolved_at ${dialect.bigintType}
     )`,
  ];
}

/** Author declarations are record metadata, not timestamped labeler claims. */
export interface SelfLabel {
  val: string;
}

const utf8Encoder = new TextEncoder();

/** Read only the standard root container. No database access or enforcement.
 * The returned values belong to this record version; its envelope supplies
 * the author/URI/CID. Never trust provenance fields supplied in a declaration. */
export function extractSelfLabels(value: unknown): SelfLabel[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const labels = (value as Record<string, unknown>).labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return [];
  const container = labels as Record<string, unknown>;
  if (
    container.$type !== "com.atproto.label.defs#selfLabels" ||
    !Array.isArray(container.values) ||
    container.values.length > 10
  )
    return [];

  const seen = new Set<string>();
  const result: SelfLabel[] = [];
  for (const item of container.values) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const val = (item as Record<string, unknown>).val;
    // Lexicon maxLength measures UTF-8 bytes, not JS code units/graphemes.
    // Reject huge strings before encoding so malformed metadata costs bounded work.
    if (
      typeof val !== "string" ||
      !val.length ||
      val.length > 128 ||
      utf8Encoder.encode(val).length > 128 ||
      seen.has(val)
    )
      continue;
    seen.add(val);
    result.push({ val });
  }
  return result;
}

/** Pick which labelers to honor for this request.
 *
 *  Order of precedence:
 *    1. `atproto-accept-labelers` header (atproto spec)
 *    2. `?labelers=` query param (fallback for SSE/WS where headers are awkward)
 *    3. `config.defaults` (operator policy)
 *    4. every entry in `config.sources`
 *
 *  Each candidate DID is checked against `config.sources`. Unknowns are
 *  dropped — we only have rows for labelers we've subscribed to.
 *
 *  Header values can carry `;param` modifiers (e.g. `did:plc:...;redact`);
 *  v1 strips and ignores those — only the bare DID is honored. */
export interface SelectedLabelers {
  /** DIDs to use for hydration this request. */
  accepted: string[];
}

export function selectAcceptedLabelers(
  headerValue: string | null | undefined,
  paramValue: string | null | undefined,
  cfg: LabelsConfig,
): SelectedLabelers {
  const cap = cfg.maxPerRequest ?? DEFAULT_LABELS_MAX_PER_REQUEST;
  const known = new Set(cfg.sources.map((s) => s.did));

  const fromCaller = parseLabelerList(headerValue) ?? parseLabelerList(paramValue);

  let candidates: string[];
  if (fromCaller && fromCaller.length > 0) {
    candidates = fromCaller;
  } else {
    candidates = (cfg.defaults ?? cfg.sources.map((s) => s.did)).slice();
  }

  const accepted: string[] = [];
  const seen = new Set<string>();
  for (const did of candidates) {
    if (seen.has(did)) continue;
    seen.add(did);
    if (known.has(did)) accepted.push(did);
    if (accepted.length >= cap) break;
  }

  return { accepted };
}

function parseLabelerList(value: string | null | undefined): string[] | null {
  if (!value) return null;
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const head = raw.split(";")[0]!.trim();
    if (head.startsWith("did:")) out.push(head);
  }
  return out.length > 0 ? out : null;
}

/** Wire-shape for a hydrated label — matches `com.atproto.label.defs#label`
 *  field-for-field so consumers can pass it straight through to atproto SDKs. */
export interface HydratedLabel {
  src: string;
  uri: string;
  val: string;
  cid?: string;
  /** Only present when true. */
  neg?: true;
  /** ISO-8601, omitted when no expiry is set. */
  exp?: string;
  /** ISO-8601 creation timestamp. */
  cts: string;
}

interface RawLabelRow {
  src: string;
  uri: string;
  val: string;
  cid: string | null;
  exp: number | null;
  cts: number;
}

/** Fetch effective labels and independent moderator actions, filter to the
 *  caller's accepted labelers and record versions, then choose one applicable
 *  label per `(src, uri, val)` for presentation. External label retractions and
 *  supersession are resolved by the SQL view before expiry/CID filtering.
 *  Subjects can be at-URIs or bare DIDs. */
export async function hydrateLabels(
  db: Database,
  subjects: string[],
  accepted: string[],
  recordCidByUri?: Map<string, string | null>,
): Promise<Record<string, HydratedLabel[]>> {
  if (subjects.length === 0 || accepted.length === 0) return {};

  const uniqSubjects = [...new Set(subjects)];
  const uniqAccepted = [...new Set(accepted)];

  const placeholders = uniqAccepted.map(() => "?").join(",");
  const nowSec = Math.floor(Date.now() / 1000);

  // Bindings via batchedInQuery are: [...prefix, ...chunk]. Put the `exp`
  // filter *before* the `__IN__` placeholder so the binding order matches
  // the SQL placeholder order.
  const rows = await batchedInQuery<RawLabelRow>(
    db,
    `SELECT src, uri, val, cid, exp, cts FROM moderation_effective_labels
       WHERE src IN (${placeholders})
         AND (exp IS NULL OR exp > ?)
         AND uri IN (__IN__)`,
    [...uniqAccepted, nowSec],
    uniqSubjects,
  );

  // Filter independent actions to the returned version before collapsing:
  // a newer action for another CID must not discard an applicable older one.
  const latestByKey = new Map<string, RawLabelRow>();
  for (const row of rows) {
    if (row.cid && recordCidByUri) {
      const recordCid = recordCidByUri.get(row.uri);
      if (recordCid !== undefined && recordCid !== row.cid) continue;
    }
    const key = `${row.src}\u0000${row.uri}\u0000${row.val}`;
    const prior = latestByKey.get(key);
    if (!prior || row.cts >= prior.cts) latestByKey.set(key, row);
  }

  const out: Record<string, HydratedLabel[]> = {};
  for (const row of latestByKey.values()) {
    const label: HydratedLabel = {
      src: row.src,
      uri: row.uri,
      val: row.val,
      cts: new Date(row.cts).toISOString(),
    };
    if (row.cid) label.cid = row.cid;
    if (row.exp != null) label.exp = new Date(row.exp * 1000).toISOString();
    (out[row.uri] ??= []).push(label);
  }

  return out;
}

/** Apply both record and author labels to every returned record (including
 * relation/reference previews). Never traverse user-controlled record.value. */
export async function attachRecordLabels(
  db: Database,
  records: FormattedRecord[],
  fields: string[],
  accepted: string[],
  profiles: ProfileEntry[] = [],
) {
  const all: FormattedRecord[] = [];
  const add = (record: FormattedRecord) => {
    all.push(record);
    for (const field of fields) {
      const value = record[field];
      if (!value || typeof value !== "object") continue;
      const entries = Array.isArray(value)
        ? value
        : "uri" in value
          ? [value]
          : Object.values(value).flat();
      for (const entry of entries)
        if (
          entry &&
          typeof entry.uri === "string" &&
          typeof entry.did === "string"
        )
          all.push(entry);
    }
  };
  records.forEach(add);
  const cidByUri = new Map(all.map((r) => [r.uri, r.cid]));
  for (const p of profiles) if (p.uri) cidByUri.set(p.uri, p.cid ?? null);
  const bySubject = await hydrateLabels(
    db,
    [
      ...all.flatMap((r) => [r.uri, r.did]),
      ...profiles.flatMap((p) => (p.uri ? [p.did, p.uri] : [p.did])),
    ],
    accepted,
    cidByUri,
  );
  for (const p of profiles) {
    const labels = [
      ...(bySubject[p.did] ?? []),
      ...(p.uri ? (bySubject[p.uri] ?? []) : []),
    ];
    if (labels.length) p.labels = labels;
  }
  for (const r of all) {
    const labels = [...(bySubject[r.uri] ?? []), ...(bySubject[r.did] ?? [])];
    if (labels.length) r.labels = labels;
  }
  return bySubject;
}
