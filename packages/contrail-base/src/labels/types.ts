import type { Database } from "../types";

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
  /** Creation timestamp, unix seconds — what we collapse on. */
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

