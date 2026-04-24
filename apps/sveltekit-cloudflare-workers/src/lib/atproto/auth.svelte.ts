import { AppBskyActorDefs } from '@atcute/bluesky';
import type { ActorIdentifier, Did } from '@atcute/lexicons';
import { page } from '$app/state';
import { ALLOW_SIGNUP, REDIRECT_TO_LAST_PAGE_ON_LOGIN } from './settings';

export const user = {
	get profile() {
		return (page.data?.profile as AppBskyActorDefs.ProfileViewDetailed | null) ?? null;
	},
	get isLoggedIn() {
		return !!page.data?.did;
	},
	get did() {
		return (page.data?.did as Did | null) ?? null;
	}
};

function saveReturnTo() {
	if (REDIRECT_TO_LAST_PAGE_ON_LOGIN) {
		document.cookie = `oauth_return_to=${encodeURIComponent(window.location.pathname + window.location.search)};path=/;max-age=600;samesite=lax`;
	}
}

export async function login(handle: string) {
	if (handle.startsWith('did:')) {
		if (handle.length < 6) throw new Error('DID must be at least 6 characters');
	} else if (handle.includes('.') && handle.length > 3) {
		handle = (handle.startsWith('@') ? handle.slice(1) : handle) as ActorIdentifier;
		if (handle.length < 4) throw new Error('Handle must be at least 4 characters');
	} else if (handle.length > 3) {
		handle = ((handle.startsWith('@') ? handle.slice(1) : handle) +
			'.bsky.social') as ActorIdentifier;
	} else {
		throw new Error('Please provide a valid handle or DID.');
	}

	const { oauthLogin } = await import('./server/oauth.remote');
	const { url } = await oauthLogin({ handle });
	saveReturnTo();
	window.location.assign(url);

	// Wait for navigation (prevents UI flash)
	await new Promise((_resolve, reject) => {
		window.addEventListener('pageshow', () => reject(new Error('user aborted the login request')), {
			once: true
		});
	});
}

export async function signup() {
	if (!ALLOW_SIGNUP) throw new Error('Signup is not enabled');

	const { oauthLogin } = await import('./server/oauth.remote');
	const { url } = await oauthLogin({ signup: true });
	saveReturnTo();
	window.location.assign(url);

	await new Promise((_resolve, reject) => {
		window.addEventListener('pageshow', () => reject(new Error('user aborted the signup request')), {
			once: true
		});
	});
}

export async function logout() {
	try {
		const { oauthLogout } = await import('./server/oauth.remote');
		await oauthLogout();
	} catch (e) {
		console.error('Error logging out:', e);
	}

	// Full reload to clear server session state
	window.location.href = '/';
}
