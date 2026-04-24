import type { Did } from '@atcute/lexicons';
import { getDetailedProfile, describeRepo } from '../methods';

const PROFILE_CACHE_TTL = 60 * 60; // 1 hour

/**
 * Loads a user's profile, with optional KV caching.
 * Falls back to a fresh fetch if the cache KV doesn't exist or on cache miss.
 * Returns undefined if the profile can't be loaded.
 */
export async function loadProfile(did: Did, profileCache?: KVNamespace) {
	// Try cache first
	if (profileCache) {
		try {
			const cached = await profileCache.get(did, 'json');
			if (cached) return cached as Record<string, unknown>;
		} catch {
			// Cache read failed, continue to fresh fetch
		}
	}

	const profile = await fetchProfile(did);

	// Write to cache (fire-and-forget)
	if (profileCache && profile) {
		profileCache
			.put(did, JSON.stringify(profile), { expirationTtl: PROFILE_CACHE_TTL })
			.catch(() => {});
	}

	return profile;
}

async function fetchProfile(did: Did) {
	try {
		let profile = await getDetailedProfile({ did });

		if (!profile || profile.handle === 'handle.invalid') {
			const repo = await describeRepo({ did });
			profile = {
				did,
				handle: repo?.handle || 'handle.invalid'
			} as typeof profile;
		}

		return profile;
	} catch (e) {
		console.error('Failed to load profile:', e);
		return undefined;
	}
}
