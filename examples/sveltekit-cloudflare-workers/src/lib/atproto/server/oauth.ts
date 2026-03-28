import {
	OAuthClient,
	MemoryStore,
	type ClientAssertionPrivateJwk,
	type OAuthClientStores,
	type OAuthSession,
	type StoredSession,
	type StoredState
} from '@atcute/oauth-node-client';
import type { Did } from '@atcute/lexicons';
import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver
} from '@atcute/identity-resolver';
import { KVStore } from './kv-store';
import { DOH_RESOLVER, REDIRECT_PATH, scopes } from '../settings';
import { DEV_PORT } from '../port';
import { dev } from '$app/environment';

function createActorResolver() {
	return new LocalActorResolver({
		handleResolver: new CompositeHandleResolver({
			methods: {
				dns: new DohJsonHandleResolver({ dohUrl: DOH_RESOLVER }),
				http: new WellKnownHandleResolver()
			}
		}),
		didDocumentResolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver(),
				web: new WebDidDocumentResolver()
			}
		})
	});
}

function createStores(env?: App.Platform['env']): OAuthClientStores {
	if (env?.OAUTH_SESSIONS && env?.OAUTH_STATES) {
		return {
			sessions: new KVStore<Did, StoredSession>(env.OAUTH_SESSIONS),
			states: new KVStore<string, StoredState>(env.OAUTH_STATES, { expirationTtl: 600 })
		};
	}
	// Fallback to in-memory stores (dev without wrangler)
	return {
		sessions: new MemoryStore<Did, StoredSession>(),
		states: new MemoryStore<string, StoredState>({ ttl: 600_000 })
	};
}

export function createOAuthClient(env?: App.Platform['env']): OAuthClient {
	const actorResolver = createActorResolver();
	const stores = createStores(env);

	if (dev && !env?.OAUTH_PUBLIC_URL) {
		// Dev without tunnel: loopback public client (no keyset).
		// Omit client_id — the library builds it automatically from redirect_uris + scope.
		// redirect_uris must use 127.0.0.1 (not localhost).
		return new OAuthClient({
			metadata: {
				redirect_uris: [`http://127.0.0.1:${DEV_PORT}${REDIRECT_PATH}`],
				scope: scopes
			},
			actorResolver,
			stores
		});
	}

	// Confidential client (production, or dev with tunnel via OAUTH_PUBLIC_URL)
	if (!env?.OAUTH_PUBLIC_URL) {
		throw new Error('OAUTH_PUBLIC_URL is not set');
	}
	if (!env.CLIENT_ASSERTION_KEY) {
		throw new Error('CLIENT_ASSERTION_KEY secret is not set. Run: pnpm env:generate-key');
	}
	const site = env.OAUTH_PUBLIC_URL;
	const key: ClientAssertionPrivateJwk = JSON.parse(env.CLIENT_ASSERTION_KEY);

	return new OAuthClient({
		metadata: {
			client_id: site + '/oauth-client-metadata.json',
			redirect_uris: [site + REDIRECT_PATH],
			scope: scopes,
			jwks_uri: site + '/oauth/jwks.json'
		},
		keyset: [key],
		actorResolver,
		stores
	});
}

export type { OAuthSession };
