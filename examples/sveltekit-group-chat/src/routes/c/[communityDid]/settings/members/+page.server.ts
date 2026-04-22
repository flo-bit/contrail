import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import type { Client } from '@atcute/client';
import { authedFetch } from '$lib/rooms/server';
import { buildMembersUri } from '$lib/rooms/uri';

interface MemberRow {
	did?: string;
	spaceUri?: string;
	accessLevel: string;
	grantedBy: string;
	grantedAt: number;
}

export const load: PageServerLoad = async ({ locals, params, platform }) => {
	if (!locals.did || !locals.client) error(401, 'Not authenticated');
	const communityDid = decodeURIComponent(params.communityDid);
	const membersUri = buildMembersUri(communityDid);
	const ctx = {
		env: platform!.env,
		client: locals.client as Client,
		did: locals.did as string
	};

	let members: MemberRow[] = [];
	try {
		const data = await authedFetch<{
			rows?: Array<{
				subject: { did?: string; spaceUri?: string };
				accessLevel: string;
				grantedBy: string;
				grantedAt: number;
			}>;
		}>(ctx, 'tools.atmo.chat.community.space.listMembers', {
			query: { spaceUri: membersUri }
		});
		members = (data.rows ?? []).map((r) => ({
			did: r.subject.did,
			spaceUri: r.subject.spaceUri,
			accessLevel: r.accessLevel,
			grantedBy: r.grantedBy,
			grantedAt: r.grantedAt
		}));
	} catch {
		// empty list
	}

	return { communityDid, membersUri, members };
};
