import type { LayoutServerLoad } from './$types';
import { loadProfile } from '$lib/atproto/server/profile';

export const load: LayoutServerLoad = async ({ locals, platform }) => {
	if (!locals.did || !locals.client) {
		return { did: null, profile: null };
	}

	const profile = await loadProfile(locals.did, platform?.env?.PROFILE_CACHE);

	return {
		did: locals.did,
		profile
	};
};
