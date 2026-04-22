import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { buildSpaceUri } from '$lib/rooms/uri';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.did || !locals.client) error(401, 'Not authenticated');
	const communityDid = decodeURIComponent(params.communityDid);
	const spaceUri = buildSpaceUri(communityDid, params.channelKey);
	return { spaceUri, channelKey: params.channelKey, myDid: locals.did };
};
