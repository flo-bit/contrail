import type { LabelsConfig } from "./types";
import { DEFAULT_LABELS_MAX_PER_REQUEST } from "./types";

/** Pick which labelers to honor for this request.
 *
 *  Order of precedence:
 *    1. `atproto-accept-labelers` header (atproto spec)
 *    2. `?labelers=` query param (fallback for SSE/WS where headers are awkward)
 *    3. `config.defaults` (operator policy)
 *    4. every entry in `config.sources`
 *
 *  Each candidate DID is checked against `config.sources`. Unknown DIDs are
 *  dropped unless `allowUserSupplied: true`, in which case they're returned
 *  in `lazyAdd` for the caller to schedule a registration. The active
 *  request gets results only from already-indexed sources.
 *
 *  Header values can carry `;param` modifiers (e.g. `did:plc:...;redact`);
 *  v1 strips and ignores those — only the bare DID is honored. */
export interface SelectedLabelers {
  /** DIDs to use for hydration this request. */
  accepted: string[];
  /** DIDs the caller asked for that aren't configured (only populated when
   *  `allowUserSupplied: true`). The hydrator ignores these for the current
   *  request — the caller should enqueue registration as a follow-up. */
  lazyAdd: string[];
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
  const lazyAdd: string[] = [];
  const seen = new Set<string>();
  for (const did of candidates) {
    if (seen.has(did)) continue;
    seen.add(did);
    if (known.has(did)) {
      accepted.push(did);
    } else if (cfg.allowUserSupplied) {
      lazyAdd.push(did);
    }
    if (accepted.length >= cap) break;
  }

  return { accepted, lazyAdd };
}

/** Parse a comma-separated DID list. Returns null when the input is empty
 *  or undefined so callers can distinguish "absent" from "empty list" (the
 *  latter — `atproto-accept-labelers: ` — is technically valid and means
 *  "no labelers"; we treat it the same as absent for ergonomics). */
function parseLabelerList(value: string | null | undefined): string[] | null {
  if (!value) return null;
  const out: string[] = [];
  for (const raw of value.split(",")) {
    // Drop `;param` modifiers from the spec (e.g. `;redact`). v1 ignores them.
    const head = raw.split(";")[0]!.trim();
    if (head.startsWith("did:")) out.push(head);
  }
  return out.length > 0 ? out : null;
}
