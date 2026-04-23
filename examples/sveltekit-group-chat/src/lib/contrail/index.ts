import {
	Contrail,
	DurableObjectPubSub,
	InMemoryPubSub,
	MemoryBlobAdapter,
	R2BlobAdapter,
	type BlobAdapter,
	type ContrailConfig,
	type DurableObjectNamespace,
	type PubSub,
	type R2BucketLike
} from '@atmo-dev/contrail';
import { createHandler } from '@atmo-dev/contrail/server';
import { Client } from '@atcute/client';
import { baseConfig } from './config';
import { getSignedCookieFromRequest } from '$lib/atproto/server/signed-cookie';

type Env = App.Platform['env'];

interface Bundle {
	contrail: Contrail;
	handle: (req: Request, db?: unknown) => unknown;
	ready: Promise<void>;
}

let cached: { env: Env; bundle: Bundle } | null = null;

function build(env: Env): Bundle {
	const devAuth = env.DEV_AUTH === '1';

	// In dev the DO class isn't wired (vite runs the worker directly, skipping
	// the post-build re-export), so fall back to InMemoryPubSub. Single-isolate
	// is fine for one-user dev; production uses the DO so publishes fan out
	// across isolates.
	const pubsub: PubSub = devAuth
		? new InMemoryPubSub()
		: new DurableObjectPubSub(env.REALTIME as DurableObjectNamespace);

	// Blob storage: in dev, an in-isolate memory adapter (bytes reset on
	// restart). In prod, bind an R2 bucket as `env.BLOBS` and it'll be used.
	const blobAdapter: BlobAdapter = env.BLOBS
		? new R2BlobAdapter(env.BLOBS as R2BucketLike)
		: new MemoryBlobAdapter();

	const config: ContrailConfig = {
		...baseConfig,
		spaces: {
			type: 'tools.atmo.chat.space',
			serviceDid: env.SERVICE_DID,
			blobs: {
				adapter: blobAdapter,
				maxSize: 2 * 1024 * 1024,
				accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
			},
			// Dev-only bypass: trust the HMAC-signed session cookie (or an
			// X-Dev-Did header for server-side synthetic requests) as auth, so
			// the loopback OAuth client doesn't need to round-trip through the
			// user's PDS for getServiceAuth (bsky.social rejects that on
			// loopback). In prod, DEV_AUTH is unset and every caller — browser
			// or third-party — must present a real atproto service-auth JWT.
			// Browsers get one by calling our SvelteKit helper which uses the
			// OAuth session to mint via the user's PDS.
			authOverride: devAuth
				? (req: Request) => {
						const headerDid = req.headers.get('x-dev-did');
						const did = headerDid ?? getSignedCookieFromRequest(req, 'did');
						if (!did) return null;
						return { issuer: did, audience: env.SERVICE_DID };
					}
				: undefined
		},
		community: {
			masterKey: env.COMMUNITY_MASTER_KEY,
			serviceDid: env.SERVICE_DID
		},
		realtime: {
			ticketSecret: env.REALTIME_TICKET_SECRET,
			pubsub
		}
	};

	const contrail = new Contrail(config);
	const handle = createHandler(contrail);
	const ready = contrail.init(env.DB);

	return { contrail, handle: handle as Bundle['handle'], ready };
}

function getBundle(env: Env): Bundle {
	if (cached && cached.env === env) return cached.bundle;
	const bundle = build(env);
	cached = { env, bundle };
	return bundle;
}

/** Get the shared contrail instance, bound to this worker's env. */
export async function getContrail(env: Env): Promise<Contrail> {
	const b = getBundle(env);
	await b.ready;
	return b.contrail;
}

/** Dispatch a Request through contrail's XRPC handler. */
export async function dispatch(req: Request, env: Env): Promise<Response> {
	const b = getBundle(env);
	await b.ready;
	return (await b.handle(req, env.DB)) as Response;
}

/** Server-side typed @atcute client that routes through contrail in-process.
 *  When `asDid` is set, every request carries an Authorization header identifying
 *  the caller — this is used only for server-originated bootstrap calls (e.g. the
 *  community mint flow) where we already have the user's DID from the OAuth session
 *  but want to bypass the atproto PDS round-trip. For normal user actions, route
 *  through the user's OAuth client instead. */
export function getServerClient(env: Env): Client {
	return new Client({
		handler: async (pathname, init) => {
			const b = getBundle(env);
			await b.ready;
			const url = new URL(pathname, 'http://localhost');
			return (await b.handle(new Request(url, init), env.DB)) as Response;
		}
	});
}
