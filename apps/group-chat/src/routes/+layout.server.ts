import type { LayoutServerLoad } from './$types';
import { dispatch } from '$lib/contrail';

interface Profile {
	handle?: string;
	displayName?: string;
	avatar?: string;
}

export const load: LayoutServerLoad = async ({ locals, platform }) => {
	if (!locals.did || !locals.client) {
		return { did: null, profile: null };
	}

	try {
		// tools.atmo.chat.getProfile is unauthenticated.
		const req = new Request(
			`http://localhost/xrpc/tools.atmo.chat.getProfile?actor=${encodeURIComponent(locals.did)}`
		);
		const res = await dispatch(req, platform!.env);
		if (!res.ok) return { did: locals.did, profile: null };
		const data = (await res.json()) as {
			profiles?: Array<{
				did: string;
				handle?: string | null;
				record?: { displayName?: string; avatar?: string };
			}>;
		};
		const entry = data.profiles?.[0];
		const profile: Profile = {
			handle: entry?.handle ?? undefined,
			displayName: entry?.value?.displayName,
			avatar: entry?.value?.avatar
		};
		return { did: locals.did, profile };
	} catch {
		return { did: locals.did, profile: null };
	}
};
