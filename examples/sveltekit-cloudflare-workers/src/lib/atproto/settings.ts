import { dev } from '$app/environment';
import { scope } from '@atcute/oauth-node-client';

// writable collections
export const collections = ['xyz.statusphere.status', 'social.atmo.test.blob'] as const;

export type AllowedCollection = (typeof collections)[number];

// OAuth scope — add scope.blob(), scope.rpc(), etc. as needed
export const scopes = [
	'atproto',
	scope.repo({ collection: [...collections] }),
	scope.blob({ accept: ['image/*'] })
];

// set to false to disable signup
export const ALLOW_SIGNUP = true;

// which PDS to use for signup (change to your preferred PDS)
const devPDS = 'https://pds.rip/';
const prodPDS = 'https://selfhosted.social/';
export const signUpPDS = dev ? devPDS : prodPDS;

// where to redirect after oauth login/signup
export const REDIRECT_PATH = '/oauth/callback';

// redirect the user back to the page they were on before login
export const REDIRECT_TO_LAST_PAGE_ON_LOGIN = true;

export const DOH_RESOLVER = 'https://mozilla.cloudflare-dns.com/dns-query';
