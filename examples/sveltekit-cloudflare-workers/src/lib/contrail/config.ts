import type { ContrailConfig } from '@atmo-dev/contrail';

export const config: ContrailConfig = {
	namespace: 'statusphere.app',
	collections: {
		'xyz.statusphere.status': {
			queryable: {
				status: {},
				createdAt: { type: 'range' }
			}
		}
	}
};
