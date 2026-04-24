import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRealtimeTicket } from '$lib/rooms/server';

/** POST { topic } → realtime ticket.
 *  Kept as a plain +server.ts endpoint rather than a remote command so that
 *  calling it doesn't trigger SvelteKit's auto-revalidation (which would
 *  cycle with the layout effect that opens the EventSource). */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.did) error(401, 'Not authenticated');
	const body = (await request.json().catch(() => null)) as { topic?: string } | null;
	if (!body?.topic) error(400, 'topic required');

	const res = await getRealtimeTicket(
		{ env: platform!.env, did: locals.did as string },
		{ topic: body.topic }
	);
	return json(res);
};
