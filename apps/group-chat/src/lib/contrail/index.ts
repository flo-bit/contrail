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
import { createHandler, createServerClient } from '@atmo-dev/contrail/server';
import type { Client } from '@atcute/client';
import { dev } from '$app/environment';
import { baseConfig } from '../contrail.config';

type Env = App.Platform['env'];

interface Bundle {
	contrail: Contrail;
	handle: (req: Request, db?: unknown) => unknown;
	ready: Promise<void>;
}

let cached: { env: Env; bundle: Bundle } | null = null;

function build(env: Env): Bundle {
	// In dev the DO class isn't wired (vite runs the worker directly, skipping
	// the post-build re-export), so fall back to InMemoryPubSub. Single-isolate
	// is fine for one-user dev; production uses the DO so publishes fan out
	// across isolates.
	const pubsub: PubSub = dev
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
			authority: {
				type: 'tools.atmo.chat.space',
				serviceDid: env.SERVICE_DID
			},
			recordHost: {
				blobs: {
					adapter: blobAdapter,
					maxSize: 2 * 1024 * 1024,
					accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
				}
			}
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

/** Typed `@atcute/client` that calls contrail in-process. Pass `did` to act
 *  as that user (server-side principal via in-process WeakMap — no JWT, no
 *  PDS roundtrip). Omit for anonymous calls against public endpoints. */
export function getServerClient(env: Env, did?: string): Client {
	return createServerClient(async (req) => {
		const b = getBundle(env);
		await b.ready;
		return (await b.handle(req, env.DB)) as Response;
	}, did);
}
