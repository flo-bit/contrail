import { redirect } from '@sveltejs/kit';
import { browserSessions, SESSION_COOKIE } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
  browserSessions.delete(cookies.get(SESSION_COOKIE));
  cookies.delete(SESSION_COOKIE, { path: '/' });
  // Keep the app's owner grant in this process for offline invite acceptance.
  redirect(303, '/');
};
