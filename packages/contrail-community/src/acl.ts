import type { AccessLevel } from "./types";
import { ACCESS_LEVELS, rankOf } from "./types";
import type { CommunityAdapter } from "./adapter";

export interface EffectiveLevelOptions {
  /** Hard cap on recursion depth when walking group-of-groups. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 8;

/** Resolve the effective access level a DID has in `spaceUri`.
 *
 *  - Direct grants: rows where subject = did.
 *  - Indirect grants: rows where subject is another space the DID is
 *    (transitively) a member of. The path-level is the MIN of every level
 *    traversed, since delegation caps access at each hop.
 *
 *  Returns `null` if the caller has no resolvable access. */
export async function resolveEffectiveLevel(
  adapter: CommunityAdapter,
  spaceUri: string,
  callerDid: string,
  opts: EffectiveLevelOptions = {}
): Promise<AccessLevel | null> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  // Walk: start with spaceUri. At each step we see who is a direct member;
  // if the caller is present, record their level (capped by the path minimum).
  let best: number = -1;
  const visited = new Set<string>();

  async function walk(targetSpace: string, pathMin: number, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (visited.has(targetSpace)) return;
    visited.add(targetSpace);
    const rows = await adapter.listAccessRows(targetSpace);
    for (const row of rows) {
      const levelRank = rankOf(row.accessLevel);
      const capped = pathMin < 0 ? levelRank : Math.min(pathMin, levelRank);
      if (row.subjectDid === callerDid) {
        if (capped > best) best = capped;
      } else if (row.subjectSpaceUri) {
        // Walk into the delegated space with the capped path level.
        await walk(row.subjectSpaceUri, capped, depth + 1);
      }
    }
  }

  await walk(spaceUri, -1, 0);
  return best >= 0 ? ACCESS_LEVELS[best]! : null;
}

/** Flatten the effective membership (DIDs with level ≥ `member`) for a space.
 *  Used by the reconciler to write `spaces_members`. */
export async function flattenEffectiveMembers(
  adapter: CommunityAdapter,
  spaceUri: string,
  opts: EffectiveLevelOptions = {}
): Promise<Set<string>> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const dids = new Set<string>();
  const visited = new Set<string>();

  async function walk(targetSpace: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (visited.has(targetSpace)) return;
    visited.add(targetSpace);
    const rows = await adapter.listAccessRows(targetSpace);
    for (const row of rows) {
      if (row.subjectDid) {
        dids.add(row.subjectDid);
      } else if (row.subjectSpaceUri) {
        await walk(row.subjectSpaceUri, depth + 1);
      }
    }
  }

  await walk(spaceUri, 0);
  return dids;
}

/** All space URIs `actorDid` can reach (directly or via delegation).
 *  Walks the reverse graph: direct grants first, then every space that
 *  delegates to an already-reachable space. Used for community.list. */
export async function resolveReachableSpaces(
  adapter: CommunityAdapter,
  actorDid: string,
  opts: EffectiveLevelOptions = {}
): Promise<Set<string>> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const reachable = new Set<string>();
  const directRows = await adapter.listAccessRowsForSubject(actorDid);
  const queue: Array<{ spaceUri: string; depth: number }> = directRows.map(
    (r) => ({ spaceUri: r.spaceUri, depth: 0 })
  );
  while (queue.length) {
    const { spaceUri, depth } = queue.shift()!;
    if (reachable.has(spaceUri)) continue;
    reachable.add(spaceUri);
    if (depth >= maxDepth) continue;
    const parents = await adapter.listSpacesDelegatingTo(spaceUri);
    for (const parent of parents) {
      if (!reachable.has(parent)) queue.push({ spaceUri: parent, depth: depth + 1 });
    }
  }
  return reachable;
}

/** Check whether the actor would cause a cycle if added as a subject-space of `spaceUri`. */
export async function wouldCycle(
  adapter: CommunityAdapter,
  spaceUri: string,
  subjectSpaceUri: string
): Promise<boolean> {
  // A cycle exists if spaceUri is reachable from subjectSpaceUri via the
  // subject-space graph.
  const visited = new Set<string>();
  const stack: string[] = [subjectSpaceUri];
  while (stack.length) {
    const s = stack.pop()!;
    if (s === spaceUri) return true;
    if (visited.has(s)) continue;
    visited.add(s);
    const rows = await adapter.listAccessRows(s);
    for (const row of rows) {
      if (row.subjectSpaceUri && !visited.has(row.subjectSpaceUri)) {
        stack.push(row.subjectSpaceUri);
      }
    }
  }
  return false;
}

export { ACCESS_LEVELS, rankOf };
