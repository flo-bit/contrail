import type { StorageAdapter as SpacesAdapter } from "../spaces/types";
import type { CommunityAdapter } from "./adapter";
import { flattenEffectiveMembers } from "./acl";

/** Reconcile `spaces_members` for `spaceUri` to match the flattened effective
 *  member set derived from `community_access_levels`. Also re-reconciles any
 *  spaces that delegate to this one (reverse-graph). */
export async function reconcile(
  community: CommunityAdapter,
  spaces: SpacesAdapter,
  spaceUri: string,
  byDid: string,
  opts: { depth?: number; maxReverseDepth?: number } = {}
): Promise<void> {
  const maxReverse = opts.maxReverseDepth ?? 8;
  const startDepth = opts.depth ?? 0;
  if (startDepth > maxReverse) return;

  const effective = await flattenEffectiveMembers(community, spaceUri);
  const current = new Set(
    (await spaces.listMembers(spaceUri)).map((m) => m.did)
  );

  const adds: string[] = [];
  const removes: string[] = [];
  for (const did of effective) if (!current.has(did)) adds.push(did);
  for (const did of current) if (!effective.has(did)) removes.push(did);

  if (adds.length || removes.length) {
    await spaces.applyMembershipDiff(spaceUri, adds, removes, byDid);
  }

  // Reverse-graph: if this space is a subject of other spaces' access rows,
  // their effective membership may have changed too.
  const parents = await community.listSpacesDelegatingTo(spaceUri);
  for (const parent of parents) {
    await reconcile(community, spaces, parent, byDid, {
      depth: startDepth + 1,
      maxReverseDepth: maxReverse,
    });
  }
}
