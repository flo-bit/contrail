import { fail, redirect } from '@sveltejs/kit';
import { cookieOptions, PENDING_COOKIE } from '$lib/server/auth';
import { matchingInvite, pendingInvites } from '$lib/server/pending';
import { getServices } from '$lib/server/prototype';
import { messageFor } from '$lib/server/messages';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, params }) => {
  const pending = matchingInvite(cookies.get(PENDING_COOKIE), params.owner, params.rkey);
  if (!pending) return { preview: null, message: null };
  try { return { preview: await getServices().invitations.preview(pending), message: null }; }
  catch (cause) { return { preview: null, message: messageFor(cause) }; }
};
export const actions: Actions = {
  preview: async ({ request, cookies, params }) => {
    const secret = String((await request.formData()).get('secret') ?? '');
    const link = { owner: params.owner, rkey: params.rkey, secret };
    try {
      const preview = await getServices().invitations.preview(link);
      pendingInvites.delete(cookies.get(PENDING_COOKIE));
      cookies.set(PENDING_COOKIE, pendingInvites.put(link), { ...cookieOptions, maxAge: 15 * 60 });
      return { preview };
    } catch (cause) { return fail(400, { message: messageFor(cause) }); }
  },
  accept: async ({ cookies, locals, params }) => {
    if (!locals.session) return fail(401, { message: 'Sign in before joining.' });
    const link = matchingInvite(cookies.get(PENDING_COOKIE), params.owner, params.rkey);
    if (!link) return fail(400, { message: 'Reopen the full invitation link to continue.' });
    let address;
    try { address = await getServices().accept(locals.session, link); }
    catch (cause) { return fail(400, { message: messageFor(cause) }); }
    pendingInvites.delete(cookies.get(PENDING_COOKIE));
    cookies.delete(PENDING_COOKIE, { path: '/' });
    redirect(303, address.path);
  },
};
