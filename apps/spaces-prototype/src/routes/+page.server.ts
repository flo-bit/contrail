import { fail, redirect } from '@sveltejs/kit';
import { getServices } from '$lib/server/prototype';
import { eventInput } from '$lib/server/events';
import { messageFor } from '$lib/server/messages';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.session) return { events: [], unavailable: false, truncated: false, message: null };
  try { return { ...await getServices().listEvents(locals.session), message: null }; }
  catch (error) { return { events: [], unavailable: false, truncated: false, message: messageFor(error) }; }
};
export const actions: Actions = {
  create: async ({ request, locals }) => {
    if (!locals.session) return fail(401, { message: 'Sign in first.' });
    let address;
    try { address = await getServices().createEvent(locals.session, eventInput(await request.formData())); }
    catch (error) { return fail(400, { message: messageFor(error) }); }
    redirect(303, address.path);
  },
};
