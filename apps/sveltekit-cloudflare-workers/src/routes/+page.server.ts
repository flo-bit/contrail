import { getServerClient } from '$lib/contrail';
import { extractProfile, type Profile } from '$lib/contrail/client';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	try {
		const client = getServerClient(platform!.env.DB);

		const res = await client.get('statusphere.app.status.listRecords', {
			params: { limit: 50, profiles: true, sort: 'createdAt', order: 'desc' }
		});

		if (!res.ok) return { statuses: [], profiles: {} };

		const records = res.data.records;
		const statuses = records
			.map((r) => {
				const value = r.value as { status: string; createdAt: string };
				return {
					did: r.did,
					rkey: r.rkey,
					status: value.status,
					createdAt: value.createdAt
				};
			})
			.filter((s) => !isNaN(new Date(s.createdAt).getTime()));

		const profiles: Record<string, Profile> = {};
		if (res.data.profiles) {
			for (const p of res.data.profiles) {
				profiles[p.did] = extractProfile(p);
			}
		}

		return { statuses, profiles };
	} catch {
		return {
			statuses: [] as { did: string; rkey: string; status: string; createdAt: string }[],
			profiles: {} as Record<string, Profile>
		};
	}
};
