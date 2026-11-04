import { error, isHttpError, redirect } from '@sveltejs/kit';
import { browserSessions, cookieOptions, FLOW_COOKIE, getOAuth, SESSION_COOKIE } from '$lib/server/auth';
import { safeReturnTo } from '$lib/server/state';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const expected = cookies.get(FLOW_COOKIE);
  cookies.delete(FLOW_COOKIE, { path: '/' });
  if (!expected || url.searchParams.get('state') !== expected) error(400, 'Sign-in expired or started in another browser. Please try again.');
  let result;
  try { result = await getOAuth().callback(url.searchParams); }
  catch { error(400, 'Sign-in failed. Please try again.'); }
  try {
    const response = await result.session.handle('/xrpc/com.atproto.server.describeServer');
    const description = await response.json() as { spacesAlpha?: boolean };
    if (!response.ok || description.spacesAlpha !== true) error(400, 'This prototype needs an account on a Spaces-enabled alpha PDS.');
  } catch (cause) {
    if (isHttpError(cause)) throw cause;
    error(502, 'Could not check PDS Spaces support. Please try again.');
  }
  browserSessions.delete(cookies.get(SESSION_COOKIE));
  cookies.set(SESSION_COOKIE, browserSessions.put(result.session.did), { ...cookieOptions, maxAge: 14 * 24 * 60 * 60 });
  const state = result.state as { returnTo?: unknown } | undefined;
  redirect(303, safeReturnTo(state?.returnTo));
};
