import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { markInProcess } from '@atmo-dev/contrail/server';
import { dispatch } from '$lib/contrail';

/** GET ?spaceUri=<uri>&cid=<cid> → blob bytes.
 *  Proxies through contrail's space.getBlob endpoint, attributing the call
 *  to the session's DID via the in-process auth marker. Browsers can't
 *  attach headers to `<img src>`, which is why this proxy exists. */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	if (!locals.did) error(401, 'Not authenticated');
	const spaceUri = url.searchParams.get('spaceUri');
	const cid = url.searchParams.get('cid');
	if (!spaceUri || !cid) error(400, 'spaceUri and cid required');

	const target = new URL('http://localhost/xrpc/tools.atmo.chat.space.getBlob');
	target.searchParams.set('spaceUri', spaceUri);
	target.searchParams.set('cid', cid);

	const req = new Request(target);
	markInProcess(req, locals.did);
	const proxied = await dispatch(req, platform!.env);
	return new Response(proxied.body, {
		status: proxied.status,
		headers: {
			'content-type': proxied.headers.get('content-type') ?? 'application/octet-stream',
			'cache-control': 'private, max-age=3600'
		}
	});
};
