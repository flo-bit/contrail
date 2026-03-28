import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';

import { generateClientAssertionKey } from '@atcute/oauth-node-client';

const cwd = process.cwd();
const examplePath = resolve(cwd, '.env.example');
const envPath = resolve(cwd, '.env');

if (!existsSync(envPath)) {
	if (!existsSync(examplePath)) {
		throw new Error(`missing .env.example (expected at ${examplePath})`);
	}
	await copyFile(examplePath, envPath);
	console.log(`created ${envPath}`);
}

const upsertVar = (input: string, key: string, value: string): string => {
	const line = `${key}=${value}`;
	const re = new RegExp(`^${key}=.*$`, 'm');

	if (re.test(input)) {
		const match = input.match(re);
		const current = match ? match[0].slice(key.length + 1).trim() : '';
		// Only overwrite if empty/placeholder
		if (current === '' || current === "''" || current === '""' || current.includes('...')) {
			return input.replace(re, line);
		}
		return input;
	}

	const suffix = input.endsWith('\n') || input.length === 0 ? '' : '\n';
	return `${input}${suffix}${line}\n`;
};

let vars = await readFile(envPath, 'utf8');

const secret = randomBytes(32).toString('base64url');
vars = upsertVar(vars, 'COOKIE_SECRET', secret);

const jwk = await generateClientAssertionKey('main-key');
vars = upsertVar(vars, 'CLIENT_ASSERTION_KEY', JSON.stringify(jwk));

await writeFile(envPath, vars);
console.log(`updated ${envPath}`);

// Generate a random dev port (5200–7200) so multiple projects can run simultaneously
const portPath = resolve(cwd, 'src/lib/atproto/port.ts');
const portFile = await readFile(portPath, 'utf8');
const currentPort = portFile.match(/DEV_PORT\s*=\s*(\d+)/);
if (currentPort && parseInt(currentPort[1]) === 5183) {
	const port = randomInt(5200, 7201);
	const updated = portFile.replace(/DEV_PORT\s*=\s*\d+/, `DEV_PORT = ${port}`);
	await writeFile(portPath, updated);
	console.log(`set DEV_PORT to ${port} in port.ts`);
} else {
	console.log(`DEV_PORT already customized (${currentPort?.[1]}), skipping`);
}
