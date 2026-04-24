/** Browser-side profile cache. DIDs → handle / displayName / avatar.
 *  Lazy: first read triggers a `<ns>.getProfile` fetch in the background;
 *  the reactive store updates when the fetch resolves, so templates reading
 *  the display string rerender automatically.
 *
 *  Kept dead simple — no eviction, no refresh. A single user session touches
 *  at most a handful of DIDs, so a plain record is fine. */

import { untrack } from 'svelte';

export interface ProfileEntry {
	did: string;
	handle?: string;
	displayName?: string;
	avatar?: string;
	/** true if we tried and failed — stops us from retrying forever. */
	failed?: boolean;
}

export const profiles = $state<Record<string, ProfileEntry>>({});
const inFlight = new Set<string>();

/** Request a profile fetch if we don't have it. Safe to call from templates. */
export function ensureProfile(did: string): void {
	if (!did) return;
	if (untrack(() => profiles[did] || inFlight.has(did))) return;
	inFlight.add(did);
	void (async () => {
		try {
			const res = await fetch(
				`/xrpc/tools.atmo.chat.getProfile?actor=${encodeURIComponent(did)}`
			);
			if (!res.ok) throw new Error(`getProfile ${res.status}`);
			const data = (await res.json()) as {
				profiles?: Array<{
					did: string;
					handle?: string | null;
					record?: { displayName?: string; avatar?: string };
				}>;
			};
			const entry = data.profiles?.[0];
			profiles[did] = {
				did,
				handle: entry?.handle ?? undefined,
				displayName: entry?.record?.displayName,
				avatar: entry?.record?.avatar
			};
		} catch {
			profiles[did] = { did, failed: true };
		} finally {
			inFlight.delete(did);
		}
	})();
}

/** Display name for a DID. Returns handle if known, else a truncated DID.
 *  Calling this from a template also kicks off a background fetch. */
export function displayName(did: string): string {
	ensureProfile(did);
	const p = profiles[did];
	if (p?.displayName) return p.displayName;
	if (p?.handle) return p.handle;
	return did.length > 14 ? `${did.slice(0, 14)}…` : did;
}

/** Handle for a DID, if known. Returns null when we don't have it yet. */
export function handleOf(did: string): string | null {
	ensureProfile(did);
	return profiles[did]?.handle ?? null;
}
