/** Write-only, post-commit observers of applied public records. */

export interface SinkContext {
  /** `live` for normal ingestion, `backfill` for replay or rebuild work. */
  phase: "live" | "backfill";
}

/** One upsert or deletion event per applied record. */
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

export interface Sink {
  /** Runs after a committed batch. Errors are logged without stopping ingestion. */
  onRecords(events: RecordEvent[], context: SinkContext): Promise<void> | void;
}
