/** Svelte 5 binding over `@atmo-dev/contrail-sync`.
 *
 *  Usage:
 *    const messagesQuery = $derived(
 *      createWatchQuery({
 *        endpoint: 'tools.atmo.chat.message',
 *        params: { spaceUri, limit: 50 }
 *      })
 *    );
 *    // template: {#each messagesQuery.records as r (r.rkey)} {r.value.text}
 *
 *  Records and params are typed via the app's generated `XRPCQueries` /
 *  `Records` ambient declarations (from `src/lexicon-types/`). Reading
 *  `.records` auto-subscribes; when no component is reading anymore
 *  (e.g. a $derived query instance is replaced on prop change), the
 *  underlying stream is torn down via `createSubscriber`.
 *
 *  Authentication: tickets are minted on demand. By default the wrapper
 *  calls the `mintWatchTicketCmd` remote function; override with
 *  `setContrailTicketMinter(fn)` if your app uses a different route.
 */

import { createSubscriber } from 'svelte/reactivity';
import { browser } from '$app/environment';
import {
	createWatchStore,
	type WatchCache,
	type WatchRecord,
	type WatchStore,
	type WatchStoreStatus
} from '@atmo-dev/contrail-sync';
import { createIndexedDBCache } from '@atmo-dev/contrail-sync/cache-idb';
import type { InferInput } from '@atcute/lexicons';
import type { BaseSchema } from '@atcute/lexicons/validations';
import type { Records, XRPCQueries } from '@atcute/lexicons/ambient';
import { dev } from '$app/environment';
import { mintWatchTicketCmd } from './rooms.remote';

// ---------------------------------------------------------------------------
// Type machinery — derives params + record types from the app's lexicons.
// ---------------------------------------------------------------------------

type WatchRecordsOf<K extends string> = `${K}.watchRecords`;

/** Params type for `<endpoint>.watchRecords`, from ambient XRPCQueries. */
type WatchParamsOf<K extends string> =
	WatchRecordsOf<K> extends keyof XRPCQueries
		? XRPCQueries[WatchRecordsOf<K>] extends { params: infer P }
			? P extends BaseSchema<unknown, unknown>
				? InferInput<P>
				: Record<string, unknown>
			: Record<string, unknown>
		: Record<string, unknown>;

/** Record value-shape for a collection, from ambient Records. */
export type RecordShapeOf<K extends string> = K extends keyof Records
	? Records[K] extends BaseSchema<unknown, unknown>
		? InferInput<Records[K]>
		: Record<string, unknown>
	: Record<string, unknown>;

/** WatchRecord with a typed `record` payload. Mirrors WatchRecord's explicit
 *  fields but without the `[k: string]: unknown` catchall (which would
 *  poison property access under `Omit`). */
export interface TypedWatchRecord<R> {
	uri: string;
	did: string;
	rkey: string;
	collection: string;
	record: R;
	time_us?: number;
	indexed_at?: number;
	cid?: string | null;
	_space?: string;
	/** Present on optimistic entries added via `addOptimistic`. */
	optimistic?: 'pending' | 'failed';
	/** Error attached via `markFailed`. */
	optimisticError?: Error;
}

// ---------------------------------------------------------------------------
// Configurable ticket minter — called when the wrapper needs a fresh ticket.
// Default: uses `mintWatchTicketCmd`. Override via `setContrailTicketMinter`.
// ---------------------------------------------------------------------------

export interface TicketMintContext {
	endpoint: string;
	params: Record<string, unknown>;
}

export type TicketMinter = (ctx: TicketMintContext) => Promise<string>;

let ticketMinter: TicketMinter | null = async ({ endpoint, params }) => {
	const spaceUri = params.spaceUri ? String(params.spaceUri) : undefined;
	const actor = params.actor ? String(params.actor) : undefined;
	const res = await mintWatchTicketCmd({
		watchRecordsNsid: `${endpoint}.watchRecords`,
		...(spaceUri ? { spaceUri } : {}),
		...(actor ? { actor } : {}),
		limit: typeof params.limit === 'number' ? params.limit : 50
	});
	return res.ticket;
};

export function setContrailTicketMinter(fn: TicketMinter | null): void {
	ticketMinter = fn;
}

// ---------------------------------------------------------------------------
// Configurable cache — persists last-seen records for instant first paint.
// Default: IndexedDB in the browser, no-op during SSR. Override via
// `setContrailCache(cache)` or opt out with `setContrailCache(null)`.
// ---------------------------------------------------------------------------

let cache: WatchCache | null = browser ? createIndexedDBCache() : null;

export function setContrailCache(next: WatchCache | null): void {
	cache = next;
}

// ---------------------------------------------------------------------------
// createWatchQuery
// ---------------------------------------------------------------------------

export interface WatchQueryOptions<K extends string> {
	/** Collection NSID. The library appends `.watchRecords` to build the URL. */
	endpoint: K;
	/** Query params for the watchRecords endpoint. Typed per-endpoint. */
	params?: WatchParamsOf<K>;
	/** Optional pre-minted ticket (typically from SSR `+page.server.ts`).
	 *  Used once on the first connect; reconnects fall through to the
	 *  configured ticket minter. */
	initialTicket?: string;
	/** Per-query override for ticket minting. If omitted, uses the minter
	 *  configured via `setContrailTicketMinter` (or the default). */
	mintTicket?: string | (() => Promise<string>);
	/** Transport. Default: 'ws' in prod, 'sse' in dev (Vite dev's DO wiring
	 *  is limited — see `todo/realtime-do-dev-wiring.md`). */
	transport?: 'sse' | 'ws';
	/** Sort comparator. Default: newest first by `time_us`. */
	compare?: (
		a: TypedWatchRecord<RecordShapeOf<K>>,
		b: TypedWatchRecord<RecordShapeOf<K>>
	) => number;
	/** Auto-reconnect on error. Default: true. */
	reconnect?: boolean;
	/** Per-query cache override. If omitted, uses the wrapper's configured
	 *  cache (see `setContrailCache`). Pass `null` to disable caching for
	 *  this query specifically. */
	cache?: WatchCache | null;
	/** Custom cache key. Defaults to the built watchRecords URL. */
	cacheKey?: string;
	/** Max records retained in cache. Default: 200. */
	cacheMaxRecords?: number;
}

export class WatchQuery<K extends string> {
	#records = $state<readonly TypedWatchRecord<RecordShapeOf<K>>[]>([]);
	#status = $state<WatchStoreStatus>('idle');
	#error = $state<Error | null>(null);
	#subscribe: () => void;
	#store: WatchStore;
	#collection: K;

	constructor(opts: WatchQueryOptions<K>) {
		const endpoint = opts.endpoint;
		const params = (opts.params ?? {}) as Record<string, unknown>;
		const url = buildWatchUrl(endpoint, params);
		this.#collection = endpoint;

		// Ticket source resolution: initialTicket (one-shot) → per-call mintTicket →
		// module-level default. Undefined if none available (public endpoints).
		let pendingInitial = opts.initialTicket;
		const hasSource = !!(opts.initialTicket || opts.mintTicket || ticketMinter);

		const mintTicket: string | (() => Promise<string>) | undefined = hasSource
			? async () => {
					if (pendingInitial) {
						const t = pendingInitial;
						pendingInitial = undefined;
						return t;
					}
					if (typeof opts.mintTicket === 'string') return opts.mintTicket;
					if (typeof opts.mintTicket === 'function') return opts.mintTicket();
					if (ticketMinter) return ticketMinter({ endpoint, params });
					throw new Error('createWatchQuery: no ticket source available');
				}
			: undefined;

		// Store is created eagerly so optimistic mutations (add/markFailed/remove)
		// can target it from non-reactive contexts (e.g. a submit handler) even
		// before any template reader has activated the subscriber. The actual
		// network connection only opens when `createSubscriber` fires `start()`
		// on first read, and closes when no readers remain.
		// Cache: explicit override (including `null`) wins over the module-level
		// default. `opts.cache === undefined` means "use whatever's configured."
		const effectiveCache = opts.cache === undefined ? cache : opts.cache;

		this.#store = createWatchStore({
			url,
			transport: opts.transport ?? (dev ? 'sse' : 'ws'),
			reconnect: opts.reconnect,
			mintTicket,
			compareRecords: opts.compare as
				| ((a: WatchRecord, b: WatchRecord) => number)
				| undefined,
			cache: effectiveCache ?? undefined,
			cacheKey: opts.cacheKey,
			cacheMaxRecords: opts.cacheMaxRecords
		});

		this.#subscribe = createSubscriber((update) => {
			const unsub = this.#store.subscribe((s) => {
				this.#records = s.records as unknown as readonly TypedWatchRecord<RecordShapeOf<K>>[];
				this.#status = s.status;
				this.#error = s.error;
				update();
			});
			this.#store.start();
			return () => {
				unsub();
				this.#store.stop();
			};
		});
	}

	get records(): readonly TypedWatchRecord<RecordShapeOf<K>>[] {
		this.#subscribe();
		return this.#records;
	}
	get status(): WatchStoreStatus {
		this.#subscribe();
		return this.#status;
	}
	get error(): Error | null {
		this.#subscribe();
		return this.#error;
	}

	/** Insert an optimistic record into the query. It shows in `.records`
	 *  immediately with `optimistic: 'pending'` and is auto-dropped when a
	 *  server-confirmed record with the same rkey arrives via the stream. */
	addOptimistic(input: {
		rkey: string;
		did: string;
		value: RecordShapeOf<K>;
		time_us?: number;
	}): void {
		this.#store.addOptimistic({
			rkey: input.rkey,
			did: input.did,
			collection: this.#collection,
			value: input.value as Record<string, unknown>,
			time_us: input.time_us
		});
	}

	/** Flip an optimistic entry's state to `'failed'` and attach an error. */
	markFailed(rkey: string, err: Error): void {
		this.#store.markFailed(rkey, err);
	}

	/** Remove an optimistic entry (explicit rollback). */
	removeOptimistic(rkey: string): void {
		this.#store.removeOptimistic(rkey);
	}
}

export function createWatchQuery<K extends string>(
	opts: WatchQueryOptions<K>
): WatchQuery<K> {
	return new WatchQuery(opts);
}

// ---------------------------------------------------------------------------

function buildWatchUrl(endpoint: string, params: Record<string, unknown>): string {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v == null) continue;
		if (Array.isArray(v)) {
			for (const item of v) qs.append(k, String(item));
		} else {
			qs.set(k, String(v));
		}
	}
	const query = qs.toString();
	return `/xrpc/${endpoint}.watchRecords${query ? `?${query}` : ''}`;
}
