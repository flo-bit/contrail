/**
 * Post-build script:
 *  - appends a `scheduled` handler to the SvelteKit worker output
 *    (adapter-cloudflare doesn't support scheduled exports natively:
 *     https://github.com/sveltejs/kit/issues/4841)
 *  - re-exports the realtime Durable Object class so wrangler's class_name binding resolves.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(root, '.svelte-kit', 'cloudflare', '_worker.js');

let code = readFileSync(workerPath, 'utf-8');

code += `
// --- Appended by scripts/append-scheduled.ts ---
import { RealtimePubSubDO as __RealtimePubSubDO } from "@atmo-dev/contrail";
export { __RealtimePubSubDO as RealtimePubSubDO };

worker_default.scheduled = async function (event, env, ctx) {
	const req = new Request('http://localhost/api/cron', {
		method: 'POST',
		headers: { 'X-Cron-Secret': env.CRON_SECRET || '' }
	});
	ctx.waitUntil(this.fetch(req, env, ctx));
};
`;

writeFileSync(workerPath, code);
console.log('Appended scheduled handler + RealtimePubSubDO re-export to _worker.js');
