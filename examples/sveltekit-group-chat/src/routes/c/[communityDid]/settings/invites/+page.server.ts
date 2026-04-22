import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import type { Client } from '@atcute/client';
import { listCommunityInvites } from '$lib/rooms/server';
import { buildMembersUri } from '$lib/rooms/uri';

export const load: PageServerLoad = async ({ locals, params, platform }) => {
	if (!locals.did || !locals.client) error(401, 'Not authenticated');
	const communityDid = decodeURIComponent(params.communityDid);
	const membersUri = buildMembersUri(communityDid);

	let invites: Array<{
		id: string;
		tokenHash: string;
		accessLevel: string;
		createdBy: string;
		createdAt: number;
		expiresAt: number | null;
		maxUses: number | null;
		usedCount: number;
		revoked: boolean;
		note: string | null;
	}> = [];
	try {
		const res = await listCommunityInvites(
			{
				env: platform!.env,
				client: locals.client as Client,
				did: locals.did as string
			},
			{ spaceUri: membersUri, includeRevoked: true }
		);
		invites = res.invites.map((r) => ({
			id: r.tokenHash.slice(0, 12),
			tokenHash: r.tokenHash,
			accessLevel: r.accessLevel,
			createdBy: r.createdBy,
			createdAt: r.createdAt,
			expiresAt: r.expiresAt,
			maxUses: r.maxUses,
			usedCount: r.usedCount,
			revoked: r.revokedAt != null,
			note: r.note
		}));
	} catch {
		// ignore — page renders with empty list
	}

	return { communityDid, membersUri, invites };
};
