import type { Did } from '@atcute/lexicons';
import { recentRecords } from '$lib/atproto/microcosm';
import { loadProfile } from '$lib/atproto/server/profile';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	try {
		const microcosmPromise = recentRecords<{ status: string; createdAt: string }>(
			'xyz.statusphere.status'
		);

		const userPromise =
			locals.client && locals.did
				? locals.client
						.get('com.atproto.repo.listRecords', {
							params: {
								repo: locals.did,
								collection: 'xyz.statusphere.status',
								limit: 20
							}
						})
						.catch(() => null)
				: null;

		const [microcosmRecords, userResponse] = await Promise.all([microcosmPromise, userPromise]);

		const microcosmStatuses = microcosmRecords.map((r) => ({
			did: r.did,
			rkey: r.rkey,
			status: r.record.status,
			createdAt: r.record.createdAt
		}));

		// Find the oldest microcosm timestamp to use as cutoff for user records
		const oldestMicrocosm =
			microcosmStatuses.length > 0
				? Math.min(...microcosmStatuses.map((s) => new Date(s.createdAt).getTime()))
				: 0;

		const userStatuses = userResponse?.ok
			? userResponse.data.records
					.map((r) => ({
						did: locals.did!,
						rkey: r.uri.split('/').pop()!,
						status: (r.value as { status: string }).status,
						createdAt: (r.value as { createdAt: string }).createdAt
					}))
					.filter((s) => new Date(s.createdAt).getTime() >= oldestMicrocosm)
			: [];

		// Merge and deduplicate by did+rkey, then sort by time descending
		const seen = new Set<string>();
		const merged = [...userStatuses, ...microcosmStatuses].filter((s) => {
			const key = `${s.did}-${s.rkey}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

		// Load profiles for all unique DIDs
		const uniqueDids = [...new Set(merged.map((s) => s.did))];
		const profileCache = platform?.env?.PROFILE_CACHE;
		const profileEntries = await Promise.all(
			uniqueDids.map(async (did) => {
				const profile = await loadProfile(did as Did, profileCache);
				if (!profile) return null;
				return [
					did,
					{
						handle: profile.handle as string,
						displayName: profile.displayName as string | undefined,
						avatar: profile.avatar as string | undefined
					}
				] as const;
			})
		);
		const profiles: Record<string, { handle: string; displayName?: string; avatar?: string }> = {};
		for (const entry of profileEntries) {
			if (entry) profiles[entry[0]] = entry[1];
		}

		return { statuses: merged, profiles };
	} catch {
		return {
			statuses: [] as { did: string; rkey: string; status: string; createdAt: string }[],
			profiles: {} as Record<string, { handle: string; displayName?: string; avatar?: string }>
		};
	}
};
