import { Contrail } from '@atmo-dev/contrail';
import { createHandler, createServerClient } from '@atmo-dev/contrail/server';
import type { Client } from '@atcute/client';
import { config } from '../contrail.config';

export const contrail = new Contrail(config);

let initialized = false;

export async function ensureInit(db: D1Database) {
	if (!initialized) {
		await contrail.init(db);
		initialized = true;
	}
}

const handle = createHandler(contrail);

/** Typed `@atcute/client` that calls Contrail in-process. */
export function getServerClient(db: D1Database): Client {
	return createServerClient(async (req) => {
		await ensureInit(db);
		return handle(req, db) as Promise<Response>;
	});
}
