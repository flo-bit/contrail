/** Sinks — write-only, post-commit observers of applied records.
 *
 *  A sink builds *derived state* from the records contrail ingests: a search
 *  index, an audit log, a webhook fan-out. It is NOT a realtime subscriber —
 *  it never serves reads, and unlike `realtime.pubsub` (a lossy, drop-oldest
 *  delivery channel for live UI feeds) it must see every applied record,
 *  including during backfill. Contrail invokes each configured sink after every
 *  `applyEvents()` commit, on BOTH the live and backfill paths, and isolates
 *  failures: a throwing sink is logged and never blocks ingestion.
 *
 *  Scope — public records only. The fan-out lives in `applyEvents`, so sinks
 *  see exactly what that path carries: public records. Space-scoped (private)
 *  records publish through the separate publishing-adapter and never reach
 *  `applyEvents`, so a sink cannot accidentally observe them. */

export interface SinkContext {
  /** `"live"` for jetstream / persistent ingest, `"backfill"` for replay or a
   *  rebuild-after-wipe. A sink can buffer and bulk-flush differently during a
   *  large backfill (sinks are expected to batch). */
  phase: "live" | "backfill";
}

/** One event per applied record — deduplicated. Unlike the realtime
 *  `RealtimeEvent`, a record is NOT split across `collection:` and `actor:`
 *  topics (that split is a delivery concern), and there are no `member.*`
 *  kinds. `created` covers both create and update — i.e. an upsert, matching
 *  how the realtime path already collapses them. `deleted` carries identity
 *  only. */
export type RecordEvent =
  | {
      kind: "created";
      uri: string;
      did: string;
      collection: string;
      rkey: string;
      cid: string | null;
      record: Record<string, unknown>;
      time_us: number;
    }
  | {
      kind: "deleted";
      uri: string;
      did: string;
      collection: string;
      rkey: string;
    };

/** A write-only, post-commit observer of applied records. */
export interface Sink {
  /** Called once per `applyEvents()` batch, after the DB commit. Receives the
   *  deduplicated records from that batch and the ingest `phase`. May be async;
   *  contrail awaits it. A thrown error is caught, logged via the configured
   *  logger, and never propagated — ingestion continues. */
  onRecords(events: RecordEvent[], ctx: SinkContext): Promise<void> | void;
}
