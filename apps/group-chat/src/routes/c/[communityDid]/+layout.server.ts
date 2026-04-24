import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { authedFetch } from '$lib/rooms/server';
import { buildAdminUri } from '$lib/rooms/uri';

interface ServerMeta {
	communityDid: string;
	name: string;
	description?: string;
	iconUrl?: string;
	membersUri: string;
}

export const load: LayoutServerLoad = async ({ locals, params, platform }) => {
	if (!locals.did) {
		throw redirect(302, '/');
	}
	const communityDid = decodeURIComponent(params.communityDid);
	const ctx = { env: platform!.env, did: locals.did as string };

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

	// Channels are no longer fetched here — the layout now derives them from
	// a live `createWatchQuery` against `tools.atmo.chat.channel` scoped by
	// actor=<communityDid>. New/renamed/deleted channels reflect instantly
	// without an `invalidateAll()` → server-loader roundtrip.

	// --- caller's access level on $admin -----------------------------------
	let isAdmin = false;
	try {
		const adminUri = buildAdminUri(communityDid);
		const d = await authedFetch<{ accessLevel: string | null }>(
			ctx,
			'tools.atmo.chat.spaceExt.whoami',
			{ query: { spaceUri: adminUri } }
		);
		isAdmin = d.accessLevel === 'admin' || d.accessLevel === 'owner';
	} catch {
		// stay false
	}

	return { communityDid, server, isAdmin, myDid: locals.did };
};
