import { dispatch } from '$lib/contrail';
import type { RequestHandler } from './$types';

async function handler(request: Request, platform: App.Platform | undefined) {
	return dispatch(request, platform!.env);
}

export const GET: RequestHandler = async ({ request, platform }) => handler(request, platform);
export const POST: RequestHandler = async ({ request, platform }) => handler(request, platform);
