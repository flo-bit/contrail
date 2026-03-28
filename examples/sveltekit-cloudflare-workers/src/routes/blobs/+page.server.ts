import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.client || !locals.did)
		return {
			blobs: [] as { rkey: string; blob: { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }; createdAt: string }[]
		};

	try {
		const blobResponse = await locals.client.get('com.atproto.repo.listRecords', {
			params: {
				repo: locals.did,
				collection: 'social.atmo.test.blob',
				limit: 20
			}
		});

		const blobs = blobResponse.ok
			? blobResponse.data.records.map((r) => {
					const value = r.value as {
						blob: { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number };
						createdAt: string;
					};
					return {
						rkey: r.uri.split('/').pop()!,
						blob: value.blob,
						createdAt: value.createdAt
					};
				})
			: [];

		return { blobs };
	} catch {
		return { blobs: [] };
	}
};
