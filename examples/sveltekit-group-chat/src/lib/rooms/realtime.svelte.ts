/** Browser-side realtime: single EventSource against
 *  `<ns>.realtime.subscribe?ticket=…`, keyed on `community:<did>`.
 *  - auto-renews the ticket before expiry
 *  - forwards `record.created` into `channelMessages`
 *  - bumps `unread` counts for channels that aren't open
 *  - invalidates the current page (channel list) when new channel records arrive
 */

import { untrack } from 'svelte';
import { invalidateAll } from '$app/navigation';
import { bumpUnread } from './unread.svelte';

async function fetchTicket(
	topic: string
): Promise<{ ticket: string; topics: string[]; expiresAt: number }> {
	const res = await fetch('/api/ticket', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ topic })
	});
	if (!res.ok) throw new Error(`ticket mint failed: ${res.status}`);
	return res.json() as Promise<{ ticket: string; topics: string[]; expiresAt: number }>;
}

export interface ChatMessage {
	rkey: string;
	authorDid: string;
	text: string;
	createdAt: string;
	replyTo?: string;
}

// ---- message store per-space ---------------------------------------------

const byChannel = $state<Record<string, ChatMessage[]>>({});

export const channelMessages = {
	/** Reactive — safe to read in templates / $derived. */
	get(spaceUri: string): ChatMessage[] {
		return byChannel[spaceUri] ?? [];
	},
	/** Seed the store from a server-rendered initial message list. Merges with
	 *  any realtime events that arrived before hydration. Fully untracked so
	 *  calling this from a `$effect` doesn't re-enter the effect. */
	seed(spaceUri: string, messages: ChatMessage[]) {
		untrack(() => {
			const existing = byChannel[spaceUri];
			if (!existing) {
				byChannel[spaceUri] = [...messages];
				return;
			}
			const seen = new Set(existing.map((m) => m.rkey));
			const merged = [...existing];
			for (const m of messages) {
				if (!seen.has(m.rkey)) {
					seen.add(m.rkey);
					merged.push(m);
				}
			}
			merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
			byChannel[spaceUri] = merged;
		});
	},
	append(spaceUri: string, m: ChatMessage) {
		untrack(() => {
			const arr = byChannel[spaceUri] ?? [];
			if (arr.some((x) => x.rkey === m.rkey)) return;
			byChannel[spaceUri] = [...arr, m].sort((a, b) =>
				a.createdAt < b.createdAt ? -1 : 1
			);
		});
	},
	remove(spaceUri: string, rkey: string) {
		untrack(() => {
			const arr = byChannel[spaceUri];
			if (!arr) return;
			byChannel[spaceUri] = arr.filter((m) => m.rkey !== rkey);
		});
	}
};

// ---- connection ----------------------------------------------------------

interface Connection {
	close(): void;
}

let current: { key: string; conn: Connection } | null = null;

export function connectCommunityRealtime(communityDid: string): () => void {
	const key = `community:${communityDid}`;
	// Re-use if already connected.
	if (current?.key === key) return current.conn.close;

	current?.conn.close();

	let closed = false;
	let es: EventSource | null = null;
	let renewTimer: ReturnType<typeof setTimeout> | null = null;

	const handleEvent = (rawData: string, kind: string) => {
		let ev: {
			topic: string;
			kind: string;
			payload: Record<string, unknown>;
			ts: number;
		};
		try {
			ev = JSON.parse(rawData);
		} catch {
			return;
		}
		if (kind === 'record.created') {
			const p = ev.payload as {
				spaceUri: string;
				collection: string;
				authorDid: string;
				rkey: string;
				record: Record<string, unknown>;
				createdAt: number | string;
			};
			if (p.collection === 'tools.atmo.chat.message') {
				const rec = p.record as { text?: string; createdAt?: string; replyTo?: string };
				if (rec.text && rec.createdAt) {
					channelMessages.append(p.spaceUri, {
						rkey: p.rkey,
						authorDid: p.authorDid,
						text: rec.text,
						createdAt: rec.createdAt,
						replyTo: rec.replyTo
					});
					// Bump unread if we're not currently on this channel.
					if (!isCurrentChannel(p.spaceUri)) {
						bumpUnread(p.spaceUri, rec.createdAt);
					}
				}
			} else if (p.collection === 'tools.atmo.chat.channel') {
				void invalidateAll();
			}
		} else if (kind === 'record.deleted') {
			const p = ev.payload as { spaceUri: string; collection: string; rkey: string };
			if (p.collection === 'tools.atmo.chat.message') {
				channelMessages.remove(p.spaceUri, p.rkey);
			} else if (p.collection === 'tools.atmo.chat.channel') {
				void invalidateAll();
			}
		} else if (kind === 'member.added' || kind === 'member.removed') {
			void invalidateAll();
		}
	};

	async function open() {
		if (closed) return;
		let ticketRes: { ticket: string; topics: string[]; expiresAt: number };
		try {
			ticketRes = await fetchTicket(key);
		} catch (err) {
			console.warn('realtime ticket mint failed', err);
			// backoff + retry
			renewTimer = setTimeout(open, 5000);
			return;
		}

		const url = `/xrpc/tools.atmo.chat.realtime.subscribe?ticket=${encodeURIComponent(
			ticketRes.ticket
		)}`;
		es = new EventSource(url);

		es.addEventListener('record.created', (e) => handleEvent((e as MessageEvent).data, 'record.created'));
		es.addEventListener('record.deleted', (e) => handleEvent((e as MessageEvent).data, 'record.deleted'));
		es.addEventListener('member.added', (e) => handleEvent((e as MessageEvent).data, 'member.added'));
		es.addEventListener('member.removed', (e) => handleEvent((e as MessageEvent).data, 'member.removed'));

		es.addEventListener('error', () => {
			// Browser retries automatically; only act if the stream is closed.
			if (es?.readyState === EventSource.CLOSED && !closed) {
				renewTimer = setTimeout(open, 3000);
			}
		});

		// Renew ~20s before expiry.
		const ttl = Math.max(ticketRes.expiresAt - Date.now() - 20_000, 30_000);
		renewTimer = setTimeout(() => {
			es?.close();
			es = null;
			void open();
		}, ttl);
	}

	void open();

	const conn: Connection = {
		close() {
			closed = true;
			if (renewTimer) clearTimeout(renewTimer);
			es?.close();
			if (current?.key === key) current = null;
		}
	};

	current = { key, conn };
	return () => conn.close();
}

// ---- helpers -------------------------------------------------------------

function isCurrentChannel(spaceUri: string): boolean {
	if (typeof window === 'undefined') return false;
	return currentChannelSpaceUri === spaceUri;
}

let currentChannelSpaceUri: string | null = null;

export function setCurrentChannel(spaceUri: string | null) {
	currentChannelSpaceUri = spaceUri;
}
