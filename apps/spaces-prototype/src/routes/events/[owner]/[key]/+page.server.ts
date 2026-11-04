import { error, fail, redirect } from '@sveltejs/kit';
import { invitationUrl } from '@atmo-dev/contrail-spaces-alpha/invitations';
import { ORIGIN, type RsvpStatus } from '$lib/config';
import { eventAddress } from '$lib/server/events';
import { getServices } from '$lib/server/prototype';
import { messageFor } from '$lib/server/messages';
import type { Actions, PageServerLoad } from './$types';

function addressFor(params: { owner: string; key: string }) {
  try { return eventAddress(params.owner, params.key); }
  catch { error(404, 'Event not found.'); }
}
export const load: PageServerLoad = async ({ params, locals }) => {
  const address = addressFor(params);
  if (!locals.session) return { address, details: null, message: null };
  try { return { address, details: await getServices().readEvent(locals.session, address), message: null }; }
  catch (cause) { return { address, details: null, message: messageFor(cause) }; }
};
export const actions: Actions = {
  rsvp: async ({ request, locals, params }) => {
    if (!locals.session) return fail(401, { message: 'Sign in first.' });
    const address = addressFor(params);
    try {
      const form = await request.formData();
      await getServices().rsvp(locals.session, address, String(form.get('status')) as RsvpStatus);
    } catch (cause) { return fail(400, { message: messageFor(cause) }); }
    redirect(303, address.path);
  },
  invite: async ({ locals, params }) => {
    const address = addressFor(params);
    if (locals.session?.did !== address.owner) return fail(403, { message: 'Only the host can create invitations.' });
    try {
      const link = await getServices().invitations.create(locals.session, { space: address.space, uri: address.uri });
      return { link: invitationUrl(ORIGIN, link), rkey: link.rkey };
    } catch (cause) { return fail(400, { message: messageFor(cause) }); }
  },
  revoke: async ({ request, locals, params }) => {
    const address = addressFor(params);
    if (locals.session?.did !== address.owner) return fail(403, { message: 'Only the host can revoke invitations.' });
    try {
      await getServices().invitations.revoke(locals.session, String((await request.formData()).get('rkey')));
      return { notice: 'Link revoked. Existing members keep access.' };
    } catch (cause) { return fail(400, { message: messageFor(cause) }); }
  },
};
