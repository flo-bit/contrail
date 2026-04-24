/** Cross-component connection status for the realtime subscription powering
 *  the current view. The channel page updates this as its WatchQuery status
 *  changes; the server navbar renders a tiny colored dot for it. */

import type { WatchStoreStatus } from '@atmo-dev/contrail-sync';

export const connection = $state<{ status: WatchStoreStatus }>({ status: 'idle' });

export function setConnectionStatus(status: WatchStoreStatus): void {
	connection.status = status;
}

export function resetConnectionStatus(): void {
	connection.status = 'idle';
}

/** Map status → (color, label) for the UI dot. */
export function connectionIndicator(status: WatchStoreStatus): {
	color: 'green' | 'orange' | 'red' | 'gray';
	label: string;
} {
	switch (status) {
		case 'live':
			return { color: 'green', label: 'Connected' };
		case 'connecting':
		case 'snapshot':
		case 'reconnecting':
			return { color: 'orange', label: 'Connecting…' };
		case 'closed':
			return { color: 'red', label: 'Disconnected' };
		case 'idle':
		default:
			return { color: 'gray', label: 'Idle' };
	}
}
