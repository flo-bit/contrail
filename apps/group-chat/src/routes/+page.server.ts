import type { PageServerLoad } from './$types';
import type { Client } from '@atcute/client';
import { authedFetch } from '$lib/rooms/server';
import { parseSpaceUri } from '$lib/rooms/uri';

interface ServerEntry {
	communityDid: string;
	name: string;
	description?: string;
	iconUrl?: string;
	createdAt: string;
	membersUri: string;
}

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.did || !locals.client) {
		return { loggedIn: false, servers: [] as ServerEntry[] };
	}

	const ctx = {
		env: platform!.env,
		client: locals.client as Client,
		did: locals.did as string
	};

	try {
		const data = await authedFetch<{
			records: Array<{
				did: string;
				rkey: string;
				value: {
					communityDid?: string;
					name?: string;
					description?: string;
					createdAt?: string;
					icon?: { ref?: { $link?: string } };
				};
				space?: string;
			}>;
		}>(ctx, 'tools.atmo.chat.server.listRecords', { query: { limit: '50' } });

		const servers: ServerEntry[] = [];
		for (const r of data.records) {
			if (!r.space) continue;
			const parsed = parseSpaceUri(r.space);
			if (!parsed) continue;
			if (r.did !== parsed.communityDid) continue;
			if (parsed.key !== 'members') continue;
			if (r.rkey !== 'self') continue;
			const rec = r.value;
			if (!rec?.communityDid || !rec.name || !rec.createdAt) continue;
			const iconCid = rec.icon?.ref?.$link;
			servers.push({
				communityDid: rec.communityDid,
				name: rec.name,
				description: rec.description,
				iconUrl: iconCid
					? `/api/blob?spaceUri=${encodeURIComponent(r.space)}&cid=${encodeURIComponent(iconCid)}`
					: undefined,
				createdAt: rec.createdAt,
				membersUri: r.space
			});
		}
		servers.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

		return { loggedIn: true, servers };
	} catch {
		return { loggedIn: true, servers: [] as ServerEntry[] };
	}
};
