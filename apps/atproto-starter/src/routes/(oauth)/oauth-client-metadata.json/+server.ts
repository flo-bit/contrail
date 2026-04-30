import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { createOAuthClient } from '$lib/atproto/server/oauth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform }) => {
	try {
		const oauth = createOAuthClient(platform?.env);
		return json(oauth.metadata);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error('[oauth-client-metadata]', message, e);
		// Surface the real cause in dev so misconfig isn't a silent 500.
		// In production we still hide details, but they land in `wrangler tail`.
		return json(
			{ error: 'oauth_client_misconfigured', message: dev ? message : 'See server logs' },
			{ status: 500 }
		);
	}
};
