import { error, type Handle } from '@sveltejs/kit';
import { ORIGIN } from '$lib/config';
import { restoreBrowserSession, SESSION_COOKIE } from '$lib/server/auth';

let attempts = 0;
let resetAt = 0;
export const handle: Handle = async ({ event, resolve }) => {
  if (event.url.origin !== ORIGIN) error(403, `Open this local prototype at ${ORIGIN}.`);
  if (!['GET', 'HEAD'].includes(event.request.method)) {
    if (event.request.headers.get('origin') !== ORIGIN) error(403, 'Cross-site requests are not allowed.');
    if (Number(event.request.headers.get('content-length')) > 65_536) error(413, 'Request too large.');
    // Single-machine prototype: a bounded process-wide mutation budget.
    if (Date.now() > resetAt) { attempts = 0; resetAt = Date.now() + 60_000; }
    if (++attempts > 60) error(429, 'Too many requests. Wait a minute and try again.');
  }
  try { event.locals.session = await restoreBrowserSession(event.cookies.get(SESSION_COOKIE)); }
  catch { error(503, 'Could not restore your session. Please try again.'); }
  const response = await resolve(event);
  response.headers.set('cache-control', 'private, no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  return response;
};
