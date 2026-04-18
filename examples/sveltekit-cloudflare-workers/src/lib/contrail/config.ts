import type { ContrailConfig } from '@atmo-dev/contrail';

export const config: ContrailConfig = {
	namespace: 'statusphere.app',
	collections: {
		status: {
			collection: 'xyz.statusphere.status',
			queryable: {
				status: {},
				createdAt: { type: 'range' }
			}
		}
	}
};
