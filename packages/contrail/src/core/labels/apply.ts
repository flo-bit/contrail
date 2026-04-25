import type { Database, Statement } from "../types";

/** Wire shape of a single `com.atproto.label.defs#label` entry. Field names
 *  match the spec exactly. We accept the spec's ISO-8601 strings and
 *  convert to unix seconds at the storage boundary. */
export interface IncomingLabel {
  src: string;
  uri: string;
  val: string;
  cid?: string;
  neg?: boolean;
  exp?: string;
  cts: string;
  sig?: Uint8Array;
}

/** Upsert a batch of labels. Idempotent on `(src, uri, val, cts)`. Bad rows
 *  (missing required fields, unparseable timestamps) are dropped silently;
 *  we don't want one malformed label to abort an entire labeler frame. */
export async function applyLabels(
  db: Database,
  labels: IncomingLabel[],
): Promise<number> {
  if (labels.length === 0) return 0;
  const stmts: Statement[] = [];
  let kept = 0;
  for (const l of labels) {
    if (!l.src || !l.uri || !l.val || !l.cts) continue;
    const cts = isoToUnixSec(l.cts);
    if (cts == null) continue;
    const exp = l.exp ? isoToUnixSec(l.exp) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO labels (src, uri, val, cid, neg, exp, cts, sig)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(src, uri, val, cts) DO UPDATE SET
               cid = excluded.cid,
               neg = excluded.neg,
               exp = excluded.exp,
               sig = excluded.sig`,
        )
        .bind(
          l.src,
          l.uri,
          l.val,
          l.cid ?? null,
          l.neg ? 1 : 0,
          exp,
          cts,
          l.sig ?? null,
        ),
    );
    kept++;
  }
  if (stmts.length > 0) await db.batch(stmts);
  return kept;
}

function isoToUnixSec(iso: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}
