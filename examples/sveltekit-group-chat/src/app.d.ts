// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { OAuthSession } from '@atcute/oauth-node-client';
import type { Client } from '@atcute/client';
import type { Did } from '@atcute/lexicons';
import type { DurableObjectNamespace } from '@atmo-dev/contrail';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			session: OAuthSession | null;
			client: Client | null;
			did: Did | null;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				OAUTH_SESSIONS: KVNamespace;
				OAUTH_STATES: KVNamespace;
				CLIENT_ASSERTION_KEY: string;
				COOKIE_SECRET: string;
				OAUTH_PUBLIC_URL: string;
				PROFILE_CACHE?: KVNamespace;
				DB: D1Database;
				CRON_SECRET: string;
				COMMUNITY_MASTER_KEY: string;
				REALTIME_TICKET_SECRET: string;
				SERVICE_DID: string;
				DEV_AUTH?: string;
				REALTIME: DurableObjectNamespace;
				BLOBS?: R2Bucket;
			};
		}
	}
}
import type {} from '@atcute/atproto';
import type {} from '@atcute/bluesky';

export {};
