import type { ContrailConfig } from '@atmo-dev/contrail';

/** Env-independent contrail config. Spaces/community/realtime are enabled per-request
 *  from `getContrail(env)` in `./index.ts`, since those modules need bindings or secrets
 *  that live on `platform.env`. */
export const namespace = 'tools.atmo.chat';

export const baseConfig: ContrailConfig = {
	namespace,
	collections: {
		server: {
			collection: 'tools.atmo.chat.server',
			queryable: {
				communityDid: {}
			}
		},
		channel: {
			collection: 'tools.atmo.chat.channel',
			queryable: {
				communityDid: {},
				visibility: {}
			}
		},
		message: {
			collection: 'tools.atmo.chat.message',
			queryable: {
				createdAt: { type: 'range' }
			}
		}
	}
};
