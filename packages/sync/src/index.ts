/** Client-side sync engine over `watchRecords`.
 *
 *  Consumes the event stream emitted by a contrail `<ns>.<collection>.watchRecords`
 *  endpoint and maintains a keyed, reactive-ish record store. The core is
 *  framework-agnostic — you get a subscribable store; wrap it in your
 *  framework's reactive primitives.
 *
 *  Two transports:
 *    - `sse` (default) — opens an EventSource against `url`. Simplest.
 *    - `ws` — two-step: HTTP GET to `url&mode=ws` for the snapshot + wsUrl,
 *      then WebSocket upgrade. On Cloudflare this routes the live stream
 *      through a Durable Object with hibernation, so idle connections cost
 *      near-zero at scale. */

export interface WatchRecord {
	uri: string;
	did: string;
	rkey: string;
	collection: string;
	record: Record<string, unknown>;
	time_us?: number;
	indexed_at?: number;
	cid?: string | null;
	/** Set when the record originates from a per-space table. */
	_space?: string;
	/** Present on optimistic entries added via `addOptimistic` — not set by
	 *  records arriving from the stream. Auto-dropped when a real record
	 *  with the same rkey arrives via `record.created`. */
	optimistic?: "pending" | "failed";
	/** Error attached via `markFailed` after a failed mutation. */
	optimisticError?: Error;
	/** Additional hydrated relations / references populated server-side. */
	[k: string]: unknown;
}

export interface WatchStoreOptions {
	/** Fully-qualified URL of the `watchRecords` endpoint, including query params. */
	url: string;
	/** Transport. Default: 'sse'. Use 'ws' on Cloudflare for DO-terminated
	 *  long-lived subscriptions that hibernate while idle. */
	transport?: "sse" | "ws";
	/** Watch-scoped ticket auth for the connection. Sent as `?ticket=...`
	 *  on the SSE connection or on the `mode=ws` handshake fetch.
	 *
	 *    - `string` — used as-is on every connect (good for one-shot SSR-minted
	 *      tokens; reconnects after expiry will surface a 401).
	 *    - `() => Promise<string>` — called once per connect attempt; a fresh
	 *      ticket is minted for every (re)connect.
	 *    - omitted — public (no-auth) endpoints.
	 *
	 *  For atproto-based services, tickets are typically minted server-side
	 *  via `<ns>.realtime.ticket` (or via an app-specific route that runs
	 *  the `mode=ws` handshake in-process and returns the signed ticket). */
	mintTicket?: string | (() => Promise<string>);
	/** Custom compare. Default: sort by `time_us` descending (newest first),
	 *  tie-breaking by rkey. */
	compareRecords?: (a: WatchRecord, b: WatchRecord) => number;
	/** Reconnect on error with backoff. Default: true, 1s → 30s exponential. */
	reconnect?: boolean;
	/** Optional persistent cache. When provided, the store loads cached
	 *  records at `start()` for instant first paint, then reconciles against
	 *  the live snapshot as usual. Writes are debounced and exclude
	 *  optimistic entries. */
	cache?: WatchCache;
	/** Key for this query in the cache. Defaults to `url`. */
	cacheKey?: string;
	/** Max records retained in the cache per key. Excess records (by sort
	 *  order) are dropped on write. Default: 200. */
	cacheMaxRecords?: number;
	/** Optional logger for debug output. */
	logger?: {
		log?: (...args: unknown[]) => void;
		warn?: (...args: unknown[]) => void;
		error?: (...args: unknown[]) => void;
	};
}

/** Adapter interface for persisting the last-seen records of a watch query.
 *  Implementations can back this with IndexedDB, localStorage, fs, etc.
 *  Errors should be caught internally — caching is a best-effort optimization
 *  and must never break the live stream. */
export interface WatchCache {
	read(key: string): Promise<WatchRecord[] | null>;
	write(key: string, records: WatchRecord[]): Promise<void>;
}

export type WatchStoreStatus =
	| "idle"
	| "connecting"
	| "snapshot"
	| "live"
	| "reconnecting"
	| "closed";

export interface WatchStore {
	readonly records: ReadonlyArray<WatchRecord>;
	readonly status: WatchStoreStatus;
	readonly error: Error | null;
	/** Subscribe to changes. Called once with the current state on subscribe. */
	subscribe(listener: (state: WatchStoreState) => void): () => void;
	/** Open the connection and begin consuming. Safe to call multiple times. */
	start(): void;
	/** Close the connection and clear the store. */
	stop(): void;

	/** Insert an optimistic record immediately, before the server confirms.
	 *  The entry is merged into `.records` with `optimistic: 'pending'`. When
	 *  a real record arrives via the stream with the same `rkey`, the
	 *  optimistic entry is dropped automatically. */
	addOptimistic(input: {
		rkey: string;
		did: string;
		collection?: string;
		record: Record<string, unknown>;
		time_us?: number;
		uri?: string;
	}): void;
	/** Flip an optimistic entry to `optimistic: 'failed'` and attach an error.
	 *  No-op if no optimistic entry matches. */
	markFailed(rkey: string, err: Error): void;
	/** Remove an optimistic entry (explicit rollback). */
	removeOptimistic(rkey: string): void;
}

export interface WatchStoreState {
	records: ReadonlyArray<WatchRecord>;
	status: WatchStoreStatus;
	error: Error | null;
}

// ---------------------------------------------------------------------------

const defaultCompare = (a: WatchRecord, b: WatchRecord): number => {
	const at = a.time_us ?? 0;
	const bt = b.time_us ?? 0;
	if (at !== bt) return bt - at;
	return a.rkey < b.rkey ? 1 : a.rkey > b.rkey ? -1 : 0;
};

export function createWatchStore(options: WatchStoreOptions): WatchStore {
	const compare = options.compareRecords ?? defaultCompare;
	const reconnect = options.reconnect !== false;
	const transport = options.transport ?? "sse";
	const log = options.logger ?? {};
	const cache = options.cache ?? null;
	const cacheKey = options.cacheKey ?? options.url;
	const cacheMax = options.cacheMaxRecords ?? 200;

	const byKey = new Map<string, WatchRecord>();
	/** Optimistic entries keyed by rkey. Merged into `.records`; dropped when
	 *  a real record with the same rkey arrives via `record.created`. */
	const optimisticByRkey = new Map<string, WatchRecord>();
	let sorted: WatchRecord[] = [];
	let status: WatchStoreStatus = "idle";
	let error: Error | null = null;
	const listeners = new Set<(state: WatchStoreState) => void>();

	// Debounced cache writer. Schedules one write after the current burst of
	// state changes settles, to avoid writing on every incoming event.
	let cacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
	const scheduleCacheWrite = () => {
		if (!cache) return;
		if (cacheWriteTimer) return;
		cacheWriteTimer = setTimeout(() => {
			cacheWriteTimer = null;
			void flushCache();
		}, 200);
	};
	const flushCache = async () => {
		if (!cache) return;
		// Snapshot the current server-confirmed records (exclude optimistic)
		// and trim to cacheMax.
		const confirmed: WatchRecord[] = [];
		for (const r of byKey.values()) confirmed.push(r);
		confirmed.sort(compare);
		const trimmed = confirmed.slice(0, cacheMax);
		try {
			await cache.write(cacheKey, trimmed);
		} catch (err) {
			log.warn?.("cache write failed", err);
		}
	};

	// Per-snapshot reconcile: during a snapshot we track which keys were
	// included, and on snapshot.end we evict any stale keys the previous
	// snapshot had but this one didn't. Keeps data visible across reconnects
	// and prevents stale records accumulating forever.
	let snapshotSeen: Set<string> | null = null;

	let es: EventSource | null = null;
	let ws: WebSocket | null = null;
	let started = false;
	let stopped = false;
	let backoffMs = 1000;

	const stateSnapshot = (): WatchStoreState => ({ records: sorted, status, error });

	const notify = () => {
		const s = stateSnapshot();
		for (const l of listeners) l(s);
		scheduleCacheWrite();
	};

	const resort = () => {
		const merged: WatchRecord[] = [];
		for (const r of byKey.values()) merged.push(r);
		for (const r of optimisticByRkey.values()) merged.push(r);
		sorted = merged.sort(compare);
	};

	const setStatus = (next: WatchStoreStatus, nextError: Error | null = null) => {
		status = next;
		error = nextError;
		notify();
	};

	const key = (r: { did?: string; rkey?: string; uri?: string }): string => {
		if (r.uri) return r.uri;
		if (r.did && r.rkey) return `${r.did}/${r.rkey}`;
		throw new Error("record must have uri or did+rkey");
	};

	const applySnapshotRecord = (record: WatchRecord) => {
		const k = key(record);
		byKey.set(k, record);
		snapshotSeen?.add(k);
		// If this rkey was optimistic, it's now server-confirmed.
		optimisticByRkey.delete(record.rkey);
	};

	const applyCreated = (record: WatchRecord) => {
		// Drop any optimistic entry with the same rkey — the server-confirmed
		// record replaces it.
		optimisticByRkey.delete(record.rkey);
		byKey.set(key(record), record);
		resort();
		notify();
	};

	const applyDeleted = (info: { uri?: string; did?: string; rkey?: string }) => {
		const k = key(info);
		if (!byKey.delete(k)) return;
		resort();
		notify();
	};

	const applyHydrationAdded = (
		parentUri: string,
		relation: string,
		child: WatchRecord
	) => {
		const parent = byKey.get(parentUri);
		if (!parent) return;
		const existing =
			((parent as Record<string, unknown>)[relation] as WatchRecord[] | undefined) ?? [];
		if (existing.some((c) => c.rkey === child.rkey)) return;
		(parent as Record<string, unknown>)[relation] = [...existing, child];
		resort();
		notify();
	};

	const applyHydrationRemoved = (
		parentUri: string,
		relation: string,
		childRkey: string
	) => {
		const parent = byKey.get(parentUri);
		if (!parent) return;
		const existing = (parent as Record<string, unknown>)[relation] as
			| WatchRecord[]
			| undefined;
		if (!existing) return;
		const filtered = existing.filter((c) => c.rkey !== childRkey);
		if (filtered.length === existing.length) return;
		(parent as Record<string, unknown>)[relation] = filtered;
		resort();
		notify();
	};

	// Dispatch a single decoded event envelope to the store. Shared by both
	// transports — SSE event handlers and WS message handlers both funnel here.
	type IncomingMessage =
		| { kind: "snapshot.start"; data: unknown }
		| { kind: "snapshot.record"; data: { record: WatchRecord } }
		| { kind: "snapshot.end"; data: unknown }
		| { kind: "record.created"; data: { record: WatchRecord } }
		| { kind: "record.deleted"; data: { uri?: string; did?: string; rkey?: string } }
		| {
				kind: "hydration.added";
				data: { parentUri: string; relation: string; child: WatchRecord };
		  }
		| {
				kind: "hydration.removed";
				data: { parentUri: string; relation: string; childRkey: string };
		  }
		| { kind: "member.removed"; data: unknown };

	const handleMessage = (msg: IncomingMessage) => {
		switch (msg.kind) {
			case "snapshot.start":
				setStatus("snapshot");
				backoffMs = 1000;
				// Begin reconcile pass. Stale records from the previous session
				// stay visible until snapshot.end replaces them.
				snapshotSeen = new Set();
				break;
			case "snapshot.record":
				applySnapshotRecord(msg.data.record);
				break;
			case "snapshot.end": {
				// Evict anything we had before this snapshot that the server
				// didn't re-send. Preserves continuity across reconnects
				// while still dropping records that were deleted while we
				// were disconnected.
				if (snapshotSeen) {
					for (const k of Array.from(byKey.keys())) {
						if (!snapshotSeen.has(k)) byKey.delete(k);
					}
					snapshotSeen = null;
				}
				resort();
				setStatus("live");
				break;
			}
			case "record.created":
				applyCreated(msg.data.record);
				break;
			case "record.deleted":
				applyDeleted(msg.data);
				break;
			case "hydration.added":
				applyHydrationAdded(msg.data.parentUri, msg.data.relation, msg.data.child);
				break;
			case "hydration.removed":
				applyHydrationRemoved(msg.data.parentUri, msg.data.relation, msg.data.childRkey);
				break;
			case "member.removed":
				byKey.clear();
				sorted = [];
				setStatus("closed");
				closeConnections();
				break;
		}
	};

	const closeConnections = () => {
		if (es) {
			es.close();
			es = null;
		}
		if (ws) {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			ws = null;
		}
	};

	const resolveTicket = async (): Promise<string | null> => {
		const src = options.mintTicket;
		if (!src) return null;
		return typeof src === "string" ? src : await src();
	};

	const openSse = async () => {
		let url = options.url;
		const ticket = await resolveTicket();
		if (ticket) {
			const sep = url.includes("?") ? "&" : "?";
			url += `${sep}ticket=${encodeURIComponent(ticket)}`;
		}
		const source = new EventSource(url);
		es = source;

		const on = (kind: IncomingMessage["kind"]) =>
			source.addEventListener(kind, (e) => {
				try {
					const data = JSON.parse((e as MessageEvent).data);
					handleMessage({ kind, data } as IncomingMessage);
				} catch (err) {
					log.warn?.(`${kind} parse failed`, err);
				}
			});

		on("snapshot.start");
		on("snapshot.record");
		on("snapshot.end");
		on("record.created");
		on("record.deleted");
		on("hydration.added");
		on("hydration.removed");
		on("member.removed");

		source.addEventListener("error", () => {
			if (source.readyState === EventSource.CLOSED) {
				if (stopped) return;
				setStatus("reconnecting", new Error("stream closed"));
				scheduleReconnect();
			}
		});
	};

	const openWs = async () => {
		// Step 1: snapshot + handshake. Authenticated by the watch-scoped
		// ticket from `mintTicket`, passed as `?ticket=...`. The server
		// returns a ticket bound to (did, spaceUri, querySpec); we pass that
		// back embedded in the wsUrl on the WS upgrade so the WS itself
		// doesn't need any other auth.
		let snapshotUrl = options.url;
		const sep = snapshotUrl.includes("?") ? "&" : "?";
		snapshotUrl += `${sep}mode=ws`;
		const ticket = await resolveTicket();
		if (ticket) {
			snapshotUrl += `&ticket=${encodeURIComponent(ticket)}`;
		}
		const res = await fetch(snapshotUrl, { headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`snapshot fetch failed (${res.status})`);
		const handshake = (await res.json()) as {
			transport: "ws";
			snapshot: { records: WatchRecord[]; cursor?: string };
			wsUrl: string;
			/** Watch-scoped ticket the server embeds in `wsUrl` for WS auth.
			 *  Opaque to the client; passed back verbatim on upgrade. */
			ticket?: string;
			/** Unix ms captured by the server before the snapshot ran. The
			 *  server embeds this in wsUrl as `?sinceTs=...` so the DO can
			 *  replay events from the race window on connect. */
			sinceTs?: number;
		};

		// Apply snapshot in-order.
		setStatus("snapshot");
		for (const record of handshake.snapshot.records) applySnapshotRecord(record);
		resort();
		backoffMs = 1000;

		// Step 2: open the WS. `wsUrl` is a relative path from the server;
		// resolve it against the page origin (not against options.url — both
		// are relative and `new URL(relative, relative)` throws, which
		// previously manifested as the connection indicator being stuck on
		// "connecting" while the engine re-fetched snapshots in a tight
		// loop). The server embeds the handshake ticket in it when issued.
		const g = globalThis as { location?: { origin?: string } };
		const base = g.location?.origin ?? "http://localhost";
		const wsHref = new URL(handshake.wsUrl, base);
		wsHref.protocol = wsHref.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(wsHref.toString());
		ws = socket;

		socket.addEventListener("open", () => {
			setStatus("live");
		});

		socket.addEventListener("message", (e) => {
			try {
				const parsed = JSON.parse((e as MessageEvent).data as string);
				if (!parsed || typeof parsed !== "object" || !parsed.kind) return;
				handleMessage(parsed as IncomingMessage);
			} catch (err) {
				log.warn?.("ws message parse failed", err);
			}
		});

		socket.addEventListener("close", () => {
			if (stopped) return;
			setStatus("reconnecting", new Error("ws closed"));
			scheduleReconnect();
		});

		socket.addEventListener("error", (err) => {
			log.warn?.("ws error", err);
		});
	};

	const openOnce = async () => {
		setStatus("connecting");
		try {
			if (transport === "ws") await openWs();
			else await openSse();
		} catch (err) {
			setStatus(
				"reconnecting",
				err instanceof Error ? err : new Error(String(err))
			);
			scheduleReconnect();
		}
	};

	const scheduleReconnect = () => {
		if (!reconnect || stopped) {
			setStatus("closed");
			return;
		}
		const delay = Math.min(backoffMs, 30_000);
		backoffMs = Math.min(backoffMs * 2, 30_000);
		setTimeout(() => {
			if (stopped) return;
			// Keep existing records visible; `snapshot.end` will reconcile
			// away anything that disappeared while we were offline.
			void openOnce();
		}, delay);
	};

	return {
		get records() {
			return sorted;
		},
		get status() {
			return status;
		},
		get error() {
			return error;
		},
		subscribe(listener) {
			listeners.add(listener);
			listener(stateSnapshot());
			return () => listeners.delete(listener);
		},
		start() {
			if (started) return;
			started = true;
			stopped = false;
			void (async () => {
				// Cache warm: populate from disk before opening the connection
				// so listeners see instant records on first paint.
				if (cache) {
					try {
						const cached = await cache.read(cacheKey);
						if (cached && cached.length > 0 && !stopped) {
							for (const r of cached) byKey.set(key(r), r);
							resort();
							notify();
						}
					} catch (err) {
						log.warn?.("cache read failed", err);
					}
				}
				if (stopped) return;
				void openOnce();
			})();
		},
		stop() {
			stopped = true;
			closeConnections();
			if (cacheWriteTimer) {
				clearTimeout(cacheWriteTimer);
				cacheWriteTimer = null;
			}
			// Best-effort final flush so the cache reflects the last-known
			// confirmed state before teardown.
			void flushCache();
			byKey.clear();
			optimisticByRkey.clear();
			sorted = [];
			setStatus("closed");
		},
		addOptimistic(input) {
			const now = Date.now();
			const record: WatchRecord = {
				uri: input.uri ?? `at://${input.did}/${input.collection ?? ""}/${input.rkey}`,
				did: input.did,
				rkey: input.rkey,
				collection: input.collection ?? "",
				record: input.record,
				time_us: input.time_us ?? now * 1000,
				indexed_at: now,
				cid: null,
				optimistic: "pending"
			};
			optimisticByRkey.set(input.rkey, record);
			resort();
			notify();
		},
		markFailed(rkey, err) {
			const existing = optimisticByRkey.get(rkey);
			if (!existing) return;
			optimisticByRkey.set(rkey, {
				...existing,
				optimistic: "failed",
				optimisticError: err
			});
			resort();
			notify();
		},
		removeOptimistic(rkey) {
			if (!optimisticByRkey.delete(rkey)) return;
			resort();
			notify();
		}
	};
}
