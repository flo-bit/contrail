import type { LayoutServerLoad } from './$types';
import { getServerClient } from '$lib/contrail';
import { extractProfile } from '$lib/contrail/client';

export const load: LayoutServerLoad = async ({ locals, platform }) => {
	if (!locals.did || !locals.client) {
		return { did: null, profile: null };
	}

	try {
		const client = getServerClient(platform!.env.DB);
		const res = await client.get('statusphere.app.getProfile', {
			params: { actor: locals.did }
		});

		if (!res.ok) return { did: locals.did, profile: null };

		return {
			did: locals.did,
			profile: extractProfile(res.data)
		};
	} catch {
		return { did: locals.did, profile: null };
	}
};
