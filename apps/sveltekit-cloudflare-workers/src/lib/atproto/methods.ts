import { parseResourceUri, type Did, type Handle } from '@atcute/lexicons';
import { isDid } from '@atcute/lexicons/syntax';
import { user } from './auth.svelte';
import { DOH_RESOLVER, type AllowedCollection } from './settings';
import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver
} from '@atcute/identity-resolver';
import { Client, simpleFetchHandler } from '@atcute/client';
import { type AppBskyActorDefs } from '@atcute/bluesky';

export type Collection = `${string}.${string}.${string}`;
import * as TID from '@atcute/tid';

/**
 * Parses an AT Protocol URI into its components.
 */
export function parseUri(uri: string) {
	const parts = parseResourceUri(uri);
	if (!parts.ok) return;
	return parts.value;
}

/**
 * Resolves a handle to a DID using DNS and HTTP methods.
 */
export async function resolveHandle({ handle }: { handle: Handle }) {
	const handleResolver = new CompositeHandleResolver({
		methods: {
			dns: new DohJsonHandleResolver({ dohUrl: DOH_RESOLVER }),
			http: new WellKnownHandleResolver()
		}
	});

	const data = await handleResolver.resolve(handle);
	return data;
}

/**
 * Returns a DID given a handle or DID string.
 */
export async function actorToDid(actor: string): Promise<Did> {
	if (isDid(actor)) return actor;
	return await resolveHandle({ handle: actor as Handle });
}

const didResolver = new CompositeDidDocumentResolver({
	methods: {
		plc: new PlcDidDocumentResolver(),
		web: new WebDidDocumentResolver()
	}
});

/**
 * Gets the PDS (Personal Data Server) URL for a given DID.
 */
export async function getPDS(did: Did) {
	const doc = await didResolver.resolve(did as Did<'plc'> | Did<'web'>);
	if (!doc.service) throw new Error('No PDS found');
	for (const service of doc.service) {
		if (service.id === '#atproto_pds') {
			return service.serviceEndpoint.toString();
		}
	}
}

/**
 * Fetches a detailed Bluesky profile for a user.
 */
export async function getDetailedProfile(data?: { did?: Did; client?: Client }) {
	data ??= {};
	data.did ??= user.did ?? undefined;

	if (!data.did) throw new Error('Error getting detailed profile: no did');

	data.client ??= new Client({
		handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' })
	});

	const response = await data.client.get('app.bsky.actor.getProfile', {
		params: { actor: data.did }
	});

	if (!response.ok) return;

	return response.data;
}

/**
 * Creates an AT Protocol client for a user's PDS.
 */
export async function getClient({ did }: { did: Did }) {
	const pds = await getPDS(did);
	if (!pds) throw new Error('PDS not found');

	const client = new Client({
		handler: simpleFetchHandler({ service: pds })
	});

	return client;
}

/**
 * Lists records from a repository collection with pagination support.
 */
export async function listRecords({
	did,
	collection,
	cursor,
	limit = 100,
	client
}: {
	did?: Did;
	collection: `${string}.${string}.${string}`;
	cursor?: string;
	limit?: number;
	client?: Client;
}) {
	did ??= user.did ?? undefined;
	if (!collection) {
		throw new Error('Missing parameters for listRecords');
	}
	if (!did) {
		throw new Error('Missing did for listRecords');
	}

	client ??= await getClient({ did });

	const allRecords = [];

	let currentCursor = cursor;
	do {
		const response = await client.get('com.atproto.repo.listRecords', {
			params: {
				repo: did,
				collection,
				limit: !limit || limit > 100 ? 100 : limit,
				cursor: currentCursor
			}
		});

		if (!response.ok) {
			return allRecords;
		}

		allRecords.push(...response.data.records);
		currentCursor = response.data.cursor;
	} while (currentCursor && (!limit || allRecords.length < limit));

	return allRecords;
}

/**
 * Fetches a single record from a repository.
 */
export async function getRecord({
	did,
	collection,
	rkey = 'self',
	client
}: {
	did?: Did;
	collection: Collection;
	rkey?: string;
	client?: Client;
}) {
	did ??= user.did ?? undefined;

	if (!collection) {
		throw new Error('Missing parameters for getRecord');
	}
	if (!did) {
		throw new Error('Missing did for getRecord');
	}

	client ??= await getClient({ did });

	const record = await client.get('com.atproto.repo.getRecord', {
		params: {
			repo: did,
			collection,
			rkey
		}
	});

	return JSON.parse(JSON.stringify(record.data));
}

/**
 * Creates or updates a record via remote function.
 */
export async function putRecord({
	collection,
	rkey = 'self',
	record
}: {
	collection: AllowedCollection;
	rkey?: string;
	record: Record<string, unknown>;
}) {
	if (!user.did) throw new Error('Not logged in');

	const { putRecord: putRecordRemote } = await import('./server/repo.remote');
	const data = await putRecordRemote({ collection, rkey, record });
	return { ok: true, data };
}

/**
 * Deletes a record via remote function.
 */
export async function deleteRecord({
	collection,
	rkey = 'self'
}: {
	collection: AllowedCollection;
	rkey: string;
}) {
	if (!user.did) throw new Error('Not logged in');

	const { deleteRecord: deleteRecordRemote } = await import('./server/repo.remote');
	const data = await deleteRecordRemote({ collection, rkey });
	return data.ok;
}

/**
 * Gets the dimensions of an image blob.
 */
function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const url = URL.createObjectURL(blob);
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('Failed to load image for dimensions'));
		};
		img.src = url;
	});
}

/**
 * Uploads a blob via remote function.
 * Converts the Blob to a byte array for serialization across the remote boundary.
 * For image blobs, automatically includes aspectRatio with width and height.
 */
export async function uploadBlob({
	blob,
	aspectRatio
}: {
	blob: Blob;
	aspectRatio?: { width: number; height: number };
}) {
	if (!user.did) throw new Error("Can't upload blob: Not logged in");

	// Auto-detect dimensions for image blobs if not provided
	if (!aspectRatio && blob.type.startsWith('image/')) {
		try {
			aspectRatio = await getImageDimensions(blob);
		} catch {
			// Non-critical — proceed without aspectRatio
		}
	}

	const arrayBuffer = await blob.arrayBuffer();
	const bytes = Array.from(new Uint8Array(arrayBuffer));

	const { uploadBlob: uploadBlobRemote } = await import('./server/repo.remote');
	const result = await uploadBlobRemote({ bytes, mimeType: blob.type || 'application/octet-stream' });

	if (aspectRatio) {
		return { ...result, aspectRatio };
	}
	return result;
}

/**
 * Gets metadata about a repository.
 */
export async function describeRepo({ client, did }: { client?: Client; did?: Did }) {
	did ??= user.did ?? undefined;
	if (!did) {
		throw new Error('Error describeRepo: No did');
	}
	client ??= await getClient({ did });

	const repo = await client.get('com.atproto.repo.describeRepo', {
		params: {
			repo: did
		}
	});
	if (!repo.ok) return;

	return repo.data;
}

/**
 * Constructs a URL to fetch a blob directly from a user's PDS.
 */
export async function getBlobURL({
	did,
	blob
}: {
	did: Did;
	blob: {
		$type: 'blob';
		ref: {
			$link: string;
		};
	};
}) {
	const pds = await getPDS(did);
	return `${pds}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${blob.ref.$link}`;
}

/**
 * Constructs a Bluesky CDN URL for an image blob.
 */
export function getCDNImageBlobUrl({
	did,
	blob
}: {
	did?: string;
	blob: {
		$type: 'blob';
		ref: {
			$link: string;
		};
	};
}) {
	did ??= user.did ?? undefined;

	return `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${blob.ref.$link}@webp`;
}

/**
 * Searches for actors with typeahead/autocomplete functionality.
 */
export async function searchActorsTypeahead(
	q: string,
	limit: number = 10,
	host?: string
): Promise<{ actors: AppBskyActorDefs.ProfileViewBasic[]; q: string }> {
	host ??= 'https://public.api.bsky.app';

	const client = new Client({
		handler: simpleFetchHandler({ service: host })
	});

	const response = await client.get('app.bsky.actor.searchActorsTypeahead', {
		params: {
			q,
			limit
		}
	});

	if (!response.ok) return { actors: [], q };

	return { actors: response.data.actors, q };
}

/**
 * Return a TID based on current time
 */
export function createTID() {
	return TID.now();
}
