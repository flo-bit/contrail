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
	/** Additional hydrated relations / references populated server-side. */
	[k: string]: unknown;
}

export interface WatchStoreOptions {
	/** Fully-qualified URL of the `watchRecords` endpoint, including query params. */
	url: string;
	/** Transport. Default: 'sse'. Use 'ws' on Cloudflare for DO-terminated
	 *  long-lived subscriptions that hibernate while idle. */
	transport?: "sse" | "ws";
	/** Optional: provide a ticket string (for `?ticket=...`-style auth).
	 *  When omitted, the connection is opened without an explicit token —
	 *  rely on cookies / bearer tokens your fetch policy sends automatically. */
	fetchTicket?: () => Promise<string>;
	/** Custom compare. Default: sort by `time_us` descending (newest first),
	 *  tie-breaking by rkey. */
	compareRecords?: (a: WatchRecord, b: WatchRecord) => number;
	/** Reconnect on error with backoff. Default: true, 1s → 30s exponential. */
	reconnect?: boolean;
	/** Optional logger for debug output. */
	logger?: {
		log?: (...args: unknown[]) => void;
		warn?: (...args: unknown[]) => void;
		error?: (...args: unknown[]) => void;
	};
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

	const byKey = new Map<string, WatchRecord>();
	let sorted: WatchRecord[] = [];
	let status: WatchStoreStatus = "idle";
	let error: Error | null = null;
	const listeners = new Set<(state: WatchStoreState) => void>();

	let es: EventSource | null = null;
	let ws: WebSocket | null = null;
	let started = false;
	let stopped = false;
	let backoffMs = 1000;

	const stateSnapshot = (): WatchStoreState => ({ records: sorted, status, error });

	const notify = () => {
		const s = stateSnapshot();
		for (const l of listeners) l(s);
	};

	const resort = () => {
		sorted = Array.from(byKey.values()).sort(compare);
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
		byKey.set(key(record), record);
	};

	const applyCreated = (record: WatchRecord) => {
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
				break;
			case "snapshot.record":
				applySnapshotRecord(msg.data.record);
				break;
			case "snapshot.end":
				resort();
				setStatus("live");
				break;
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

	const openSse = async () => {
		let url = options.url;
		if (options.fetchTicket) {
			const ticket = await options.fetchTicket();
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
		// Step 1: snapshot + handshake.
		let snapshotUrl = options.url;
		const sep = snapshotUrl.includes("?") ? "&" : "?";
		snapshotUrl += `${sep}mode=ws`;
		if (options.fetchTicket) {
			const ticket = await options.fetchTicket();
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

		// Step 2: open the WS. `wsUrl` is a relative path from the server.
		const wsHref = new URL(handshake.wsUrl, options.url);
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
			byKey.clear();
			sorted = [];
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
			void openOnce();
		},
		stop() {
			stopped = true;
			closeConnections();
			byKey.clear();
			sorted = [];
			setStatus("closed");
		}
	};
}
