import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import type { Client } from '@atcute/client';
import { authedFetch } from '$lib/rooms/server';
import { parseSpaceUri, buildAdminUri } from '$lib/rooms/uri';

interface ServerMeta {
	communityDid: string;
	name: string;
	description?: string;
	iconUrl?: string;
	membersUri: string;
}

interface ChannelMeta {
	spaceUri: string;
	key: string;
	name: string;
	topic?: string;
	visibility: 'public' | 'private';
	createdAt: string;
}

export const load: LayoutServerLoad = async ({ locals, params, platform }) => {
	if (!locals.did || !locals.client) {
		throw redirect(302, '/');
	}
	const communityDid = decodeURIComponent(params.communityDid);
	const ctx = {
		env: platform!.env,
		client: locals.client as Client,
		did: locals.did as string
	};

	// --- fetch server record -------------------------------------------------
	let server: ServerMeta | null = null;
	try {
		const data = await authedFetch<{
			records: Array<{
				did: string;
				rkey: string;
				record: {
					communityDid?: string;
					name?: string;
					description?: string;
					icon?: { ref?: { $link?: string } };
				};
				space?: string;
			}>;
		}>(ctx, 'tools.atmo.chat.server.listRecords', {
			query: { actor: communityDid, limit: '1' }
		});
		const row = data.records.find(
			(r) =>
				r.space &&
				r.did === communityDid &&
				r.rkey === 'self' &&
				r.record?.communityDid === communityDid
		);
		if (row?.record?.name) {
			const iconCid = row.record.icon?.ref?.$link;
			server = {
				communityDid,
				name: row.record.name,
				description: row.record.description,
				iconUrl: iconCid
					? `/api/blob?spaceUri=${encodeURIComponent(row.space!)}&cid=${encodeURIComponent(iconCid)}`
					: undefined,
				membersUri: row.space!
			};
		}
	} catch {
		// fallthrough — server stays null, UI shows "server" fallback
	}

	// --- fetch channels ------------------------------------------------------
	const channels: ChannelMeta[] = [];
	try {
		const data = await authedFetch<{
			records: Array<{
				did: string;
				rkey: string;
				record: {
					communityDid?: string;
					name?: string;
					topic?: string;
					visibility?: 'public' | 'private';
					createdAt?: string;
				};
				space?: string;
			}>;
		}>(ctx, 'tools.atmo.chat.channel.listRecords', {
			query: { actor: communityDid, limit: '100' }
		});
		for (const r of data.records) {
			if (!r.space || r.did !== communityDid || r.rkey !== 'self') continue;
			if (r.record?.communityDid !== communityDid) continue;
			if (!r.record.name || !r.record.visibility || !r.record.createdAt) continue;
			const parsed = parseSpaceUri(r.space);
			if (!parsed || parsed.key.startsWith('$') || parsed.key === 'members') continue;
			channels.push({
				spaceUri: r.space,
				key: parsed.key,
				name: r.record.name,
				topic: r.record.topic,
				visibility: r.record.visibility,
				createdAt: r.record.createdAt
			});
		}
		channels.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
	} catch {
		// fallthrough
	}

	// --- caller's access level on $admin -----------------------------------
	let isAdmin = false;
	try {
		const adminUri = buildAdminUri(communityDid);
		const d = await authedFetch<{ accessLevel: string | null }>(
			ctx,
			'tools.atmo.chat.community.space.whoami',
			{ query: { spaceUri: adminUri } }
		);
		isAdmin = d.accessLevel === 'admin' || d.accessLevel === 'owner';
	} catch {
		// stay false
	}

	return { communityDid, server, channels, isAdmin, myDid: locals.did };
};
