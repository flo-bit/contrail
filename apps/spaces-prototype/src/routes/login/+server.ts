import { error, redirect } from '@sveltejs/kit';
import type { ActorIdentifier } from '@atcute/lexicons';
import { cookieOptions, FLOW_COOKIE, getOAuth } from '$lib/server/auth';
import { safeReturnTo } from '$lib/server/state';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies }) => {
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '').trim().replace(/^@/, '');
  if (handle.length > 253 || !/^(?:did:[a-z0-9]+:[A-Za-z0-9._:%-]+|[a-z0-9][a-z0-9.-]*\.[a-z]{2,})$/i.test(handle)) error(400, 'Enter a valid account handle or DID.');
  let authorization;
  try {
    authorization = await getOAuth().authorize({
      target: { type: 'account', identifier: handle as ActorIdentifier },
      state: { returnTo: safeReturnTo(form.get('returnTo')) },
    });
  } catch { error(400, 'Could not start sign-in. Check the handle and that its PDS supports Spaces OAuth scopes.'); }
  cookies.set(FLOW_COOKIE, authorization.stateId, { ...cookieOptions, maxAge: 600 });
  redirect(303, authorization.url.toString());
};
