import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dispatch } from '$lib/contrail';
import { getSignedCookie } from '$lib/atproto/server/signed-cookie';

/** GET ?spaceUri=<uri>&cid=<cid> → blob bytes.
 *  Proxies through contrail's space.getBlob endpoint with the caller's
 *  (cookie-based in dev / JWT in prod) auth attached. */
export const GET: RequestHandler = async ({ url, locals, platform, request, cookies }) => {
	const spaceUri = url.searchParams.get('spaceUri');
	const cid = url.searchParams.get('cid');
	if (!spaceUri || !cid) error(400, 'spaceUri and cid required');

	const target = new URL('http://localhost/xrpc/tools.atmo.chat.space.getBlob');
	target.searchParams.set('spaceUri', spaceUri);
	target.searchParams.set('cid', cid);

	// Forward the session cookie so dev auth override works; in prod the
	// caller's OAuth session can mint a real JWT — but for <img src> we can't
	// attach headers from the browser, so we mint server-side.
	const headers: Record<string, string> = {};
	if (platform!.env.DEV_AUTH === '1') {
		const did = getSignedCookie(cookies, 'did');
		if (did) headers['X-Dev-Did'] = did;
	} else {
		if (!locals.client || !locals.did) error(401, 'Not authenticated');
		const authRes = await locals.client.get('com.atproto.server.getServiceAuth', {
			params: {
				aud: platform!.env.SERVICE_DID as `did:${string}:${string}`,
				lxm: 'tools.atmo.chat.space.getBlob' as `${string}.${string}.${string}`,
				exp: Math.floor(Date.now() / 1000) + 120
			}
		});
		if (authRes.ok) headers.Authorization = `Bearer ${(authRes.data as { token: string }).token}`;
	}

	const proxied = await dispatch(new Request(target, { headers }), platform!.env);
	// Pass through status + body + content-type.
	return new Response(proxied.body, {
		status: proxied.status,
		headers: {
			'content-type': proxied.headers.get('content-type') ?? 'application/octet-stream',
			'cache-control': 'private, max-age=3600'
		}
	});
};
