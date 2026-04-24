import { Client, simpleFetchHandler } from '@atcute/client';

export interface Profile {
	handle: string;
	displayName?: string;
	avatar?: string;
}

/**
 * Extract a simple profile from a contrail profile entry.
 * Contrail returns { did, handle, record: { displayName, avatar, ... } }
 * while components expect { handle, displayName?, avatar? }.
 */
export function extractProfile(entry: {
	did: string;
	handle?: string;
	record?: unknown;
}): Profile {
	const record = entry.record as { displayName?: string; avatar?: string } | undefined;
	return {
		handle: entry.handle ?? entry.did,
		displayName: record?.displayName,
		avatar: record?.avatar
	};
}

/**
 * Client-side: fully typed @atcute/client that queries the app's own /xrpc/ endpoints.
 */
export function getClient() {
	return new Client({ handler: simpleFetchHandler({ service: '' }) });
}
