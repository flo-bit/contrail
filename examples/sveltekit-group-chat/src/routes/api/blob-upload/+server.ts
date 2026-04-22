import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { Client } from '@atcute/client';
import { uploadBlob } from '$lib/rooms/server';

/** POST raw bytes (body = bytes) with ?spaceUri=<uri>&mimeType=<type>.
 *  Returns the atproto blob ref.
 *  Plain +server.ts so we can pass binary without remote-function JSON schema,
 *  and so there's no auto-revalidation. */
export const POST: RequestHandler = async ({ request, url, locals, platform }) => {
	if (!locals.did || !locals.client) error(401, 'Not authenticated');
	const spaceUri = url.searchParams.get('spaceUri');
	const mimeType = url.searchParams.get('mimeType') ?? request.headers.get('content-type');
	if (!spaceUri) error(400, 'spaceUri required');
	if (!mimeType) error(400, 'mimeType required');

	const bytes = new Uint8Array(await request.arrayBuffer());
	const blob = await uploadBlob(
		{ env: platform!.env, client: locals.client as Client, did: locals.did as string },
		{ spaceUri, mimeType, bytes }
	);
	return json(blob);
};
