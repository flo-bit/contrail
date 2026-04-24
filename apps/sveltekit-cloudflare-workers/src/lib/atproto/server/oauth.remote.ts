import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import { createOAuthClient } from './oauth';
import { getSignedCookie } from './signed-cookie';
import { scopes, signUpPDS } from '../settings';
import type { ActorIdentifier, Did } from '@atcute/lexicons';

export const oauthLogin = command(
	v.object({
		handle: v.optional(v.pipe(v.string(), v.minLength(3))),
		signup: v.optional(v.boolean())
	}),
	async (input) => {
		const { platform } = getRequestEvent();

		try {
			const oauth = createOAuthClient(platform?.env);

			const target = input.signup
				? ({ type: 'pds', serviceUrl: signUpPDS } as const)
				: ({ type: 'account', identifier: input.handle as ActorIdentifier } as const);

			const { url } = await oauth.authorize({
				target,
				scope: scopes.join(' '),
				prompt: input.signup ? 'create' : undefined
			});

			return { url: url.toString() };
		} catch (e) {
			if (e && typeof e === 'object' && 'status' in e) throw e; // re-throw SvelteKit errors
			const message = e instanceof Error ? e.message : 'Login failed';
			error(400, message);
		}
	}
);

export const oauthLogout = command(async () => {
	const { cookies, platform } = getRequestEvent();
	const did = getSignedCookie(cookies, 'did') as Did | null;

	if (did) {
		try {
			const oauth = createOAuthClient(platform?.env);
			await oauth.revoke(did);
		} catch (e) {
			console.error('Error revoking session:', e);
		}
	}

	cookies.delete('did', { path: '/' });
	cookies.delete('scope', { path: '/' });

	return { ok: true };
});
