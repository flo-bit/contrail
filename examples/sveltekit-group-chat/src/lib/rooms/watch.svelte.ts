/** Svelte 5 binding over `@atmo-dev/contrail/sync`. Turns the framework-agnostic
 *  subscribable store into a reactive `$state` object that Svelte effects can
 *  observe in the usual way.
 *
 *  Usage:
 *    const query = createWatchQuery({
 *      url: `/xrpc/tools.atmo.chat.message.watchRecords?spaceUri=${encodeURIComponent(spaceUri)}`,
 *    });
 *    // template: {#each query.records as r (r.uri)} ...
 *    // teardown: $effect(() => () => query.stop());
 */

import { createWatchStore, type WatchRecord, type WatchStoreOptions, type WatchStoreStatus } from '@atmo-dev/contrail/sync';

export interface WatchQuery {
	readonly records: ReadonlyArray<WatchRecord>;
	readonly status: WatchStoreStatus;
	readonly error: Error | null;
	stop(): void;
}

export function createWatchQuery(options: WatchStoreOptions): WatchQuery {
	const state = $state<{
		records: ReadonlyArray<WatchRecord>;
		status: WatchStoreStatus;
		error: Error | null;
	}>({
		records: [],
		status: 'idle',
		error: null
	});

	const store = createWatchStore(options);
	const unsub = store.subscribe((s) => {
		state.records = s.records;
		state.status = s.status;
		state.error = s.error;
	});
	store.start();

	return {
		get records() {
			return state.records;
		},
		get status() {
			return state.status;
		},
		get error() {
			return state.error;
		},
		stop() {
			unsub();
			store.stop();
		}
	};
}
