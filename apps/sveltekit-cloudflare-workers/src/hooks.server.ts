import type { Handle } from '@sveltejs/kit';
import { restoreSession } from '$lib/atproto/server/session';

export const handle: Handle = async ({ event, resolve }) => {
	const { session, client, did } = await restoreSession(
		event.cookies,
		event.platform?.env
	);

	event.locals.session = session;
	event.locals.client = client;
	event.locals.did = did;

	return resolve(event);
};
