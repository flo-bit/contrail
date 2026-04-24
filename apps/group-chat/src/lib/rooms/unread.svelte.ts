/** Per-space unread tracker.
 *  - `counts[spaceUri]` is the number of record.created events received since
 *    the space was last opened.
 *  - `lastRead[spaceUri]` is the iso timestamp of the last "open" event,
 *    persisted to localStorage so cold loads can compare against existing
 *    messages' createdAt to derive initial dot state.
 *
 *  Reset counts call on channel open via `markLastRead()` / `resetUnread()`. */

import { untrack } from 'svelte';

const LS_KEY = 'rooms:lastRead:v1';

function loadLastRead(): Record<string, string> {
	if (typeof localStorage === 'undefined') return {};
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed ? parsed : {};
	} catch {
		return {};
	}
}

function persistLastRead(v: Record<string, string>) {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(v));
	} catch {
		// ignore quota errors
	}
}

export const unread = $state<{
	counts: Record<string, number>;
	lastRead: Record<string, string>;
}>({
	counts: {},
	lastRead: loadLastRead()
});

/** Called when a record.created event for a space arrives while the space is
 *  not the active one. Increments the unread counter.
 *
 *  Whole body is wrapped in `untrack` so that a caller running inside a
 *  `$effect` does NOT subscribe to any of the `unread.*` state we read here.
 *  Writes still notify real dependents — we just stop the current effect from
 *  subscribing to state it's about to mutate and re-reading it afterwards. */
export function bumpUnread(spaceUri: string, createdAt?: string) {
	untrack(() => {
		const last = unread.lastRead[spaceUri];
		if (createdAt && last && createdAt <= last) return;
		unread.counts[spaceUri] = (unread.counts[spaceUri] ?? 0) + 1;
	});
}

/** Called when a channel view mounts or receives new messages while focused. */
export function markLastRead(spaceUri: string) {
	untrack(() => {
		const next = { ...unread.lastRead, [spaceUri]: new Date().toISOString() };
		unread.counts[spaceUri] = 0;
		unread.lastRead = next;
		persistLastRead(next);
	});
}

export function resetUnread(spaceUri: string) {
	untrack(() => {
		if (unread.counts[spaceUri]) unread.counts[spaceUri] = 0;
	});
}
