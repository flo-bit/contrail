import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** POST { lxm } → { token } — mint an atproto service-auth JWT scoped to one
 *  XRPC method, using the caller's OAuth session to call getServiceAuth on
 *  their PDS. Used by the browser sync engine to auth the watchRecords
 *  handshake fetch — it can't mint JWTs itself, but same-origin to us it
 *  can delegate.
 *
 *  Cross-origin apps skip this and mint their own JWTs server-side. */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.did || !locals.client) error(401, 'Not authenticated');
	const body = (await request.json().catch(() => null)) as { lxm?: string } | null;
	if (!body?.lxm) error(400, 'lxm required');

	const res = await locals.client.get('com.atproto.server.getServiceAuth', {
		params: {
			aud: platform!.env.SERVICE_DID as `did:${string}:${string}`,
			lxm: body.lxm as `${string}.${string}.${string}`,
			exp: Math.floor(Date.now() / 1000) + 120
		}
	});
	if (!res.ok) error(502, `getServiceAuth failed: ${JSON.stringify(res.data)}`);
	return json({ token: (res.data as { token: string }).token });
};
