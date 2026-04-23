/** Server-side helpers for calling contrail's authenticated XRPCs.
 *
 *  Contrail's community/space/realtime endpoints authenticate via atproto
 *  service-auth JWTs. The caller's OAuth session on their PDS can mint those
 *  JWTs via `com.atproto.server.getServiceAuth`. This module wraps that dance:
 *  mint → dispatch → return the typed body.
 */

import type { Client } from '@atcute/client';
import { dispatch } from '$lib/contrail';

type Env = App.Platform['env'];

interface AuthedCallContext {
	env: Env;
	/** Caller's OAuth-authenticated atproto client (talks to their PDS). */
	client: Client;
	/** Caller's DID. */
	did: string;
}

/** Authenticated fetch for page loaders — mints a service-auth JWT
 *  (or takes the dev bypass) and dispatches to contrail in-process.
 *  Returns the parsed JSON body, or throws with status + payload. */
export async function authedFetch<T = unknown>(
	ctx: AuthedCallContext,
	method: string,
	opts: { query?: Record<string, string>; body?: unknown } = {}
): Promise<T> {
	return callContrail<T>(ctx, method, opts);
}

async function mintServiceAuth(
	ctx: AuthedCallContext,
	lxm: string,
	expSeconds = 60
): Promise<string> {
	// Dev bypass: the contrail authOverride trusts our signed session cookie
	// instead of a real JWT, so we don't need to hit the PDS. Returns a sentinel
	// the override ignores (any string is fine — it's never verified).
	if (ctx.env.DEV_AUTH === '1') {
		return 'dev';
	}
	const res = await ctx.client.get('com.atproto.server.getServiceAuth', {
		params: {
			aud: ctx.env.SERVICE_DID as `did:${string}:${string}`,
			lxm: lxm as `${string}.${string}.${string}`,
			exp: Math.floor(Date.now() / 1000) + expSeconds
		}
	});
	if (!res.ok) {
		throw new Error(`getServiceAuth failed: ${JSON.stringify(res.data)}`);
	}
	const data = res.data as { token: string };
	return data.token;
}

async function callContrail<T = unknown>(
	ctx: AuthedCallContext,
	method: string,
	opts: { body?: unknown; query?: Record<string, string>; httpMethod?: 'GET' | 'POST' }
): Promise<T> {
	const jwt = await mintServiceAuth(ctx, method);
	const url = new URL(`http://localhost/xrpc/${method}`);
	for (const [k, v] of Object.entries(opts.query ?? {})) {
		url.searchParams.set(k, v);
	}
	const httpMethod = opts.httpMethod ?? (opts.body === undefined ? 'GET' : 'POST');
	const devAuth = ctx.env.DEV_AUTH === '1';
	const headers: Record<string, string> = {
		Authorization: `Bearer ${jwt}`,
		...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {})
	};
	if (devAuth) headers['X-Dev-Did'] = ctx.did;
	const req = new Request(url, {
		method: httpMethod,
		headers,
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
	});
	const res = await dispatch(req, ctx.env);
	const text = await res.text();
	const json = text ? JSON.parse(text) : {};
	if (!res.ok) {
		const err = new Error(`${method} failed (${res.status}): ${text}`);
		(err as Error & { status: number; payload: unknown }).status = res.status;
		(err as Error & { status: number; payload: unknown }).payload = json;
		throw err;
	}
	return json as T;
}

// --- community lifecycle ----------------------------------------------------

export async function mintCommunity(
	ctx: AuthedCallContext,
	input: { handle?: string } = {}
): Promise<{ communityDid: string; recoveryKey: unknown }> {
	return callContrail(ctx, 'tools.atmo.chat.community.mint', { body: input });
}

// --- space (channel / role) lifecycle --------------------------------------

export async function createSpace(
	ctx: AuthedCallContext,
	input: { communityDid: string; key?: string }
): Promise<{ space: { uri: string; key: string; ownerDid: string } }> {
	return callContrail(ctx, 'tools.atmo.chat.community.space.create', { body: input });
}

export async function grantAccess(
	ctx: AuthedCallContext,
	input: {
		spaceUri: string;
		subject: { did?: string; spaceUri?: string };
		accessLevel: 'member' | 'manager' | 'admin' | 'owner';
	}
): Promise<{ ok: true }> {
	return callContrail(ctx, 'tools.atmo.chat.community.space.grant', { body: input });
}

export async function revokeAccess(
	ctx: AuthedCallContext,
	input: { spaceUri: string; subject: { did?: string; spaceUri?: string } }
): Promise<{ ok: true }> {
	return callContrail(ctx, 'tools.atmo.chat.community.space.revoke', { body: input });
}

export async function setAccessLevel(
	ctx: AuthedCallContext,
	input: {
		spaceUri: string;
		subject: { did?: string; spaceUri?: string };
		accessLevel: 'member' | 'manager' | 'admin' | 'owner';
	}
): Promise<{ ok: true }> {
	return callContrail(ctx, 'tools.atmo.chat.community.space.setAccessLevel', { body: input });
}

// --- community records (authored by community DID) -------------------------

export async function communityPutRecord(
	ctx: AuthedCallContext,
	input: {
		spaceUri: string;
		collection: string;
		rkey?: string;
		record: Record<string, unknown>;
	}
): Promise<{ rkey: string; authorDid: string; createdAt: number }> {
	return callContrail(ctx, 'tools.atmo.chat.community.space.putRecord', { body: input });
}

// --- user records in a space -----------------------------------------------

export async function spacePutRecord(
	ctx: AuthedCallContext,
	input: {
		spaceUri: string;
		collection: string;
		rkey?: string;
		record: Record<string, unknown>;
	}
): Promise<{ rkey: string; authorDid: string; createdAt: number }> {
	return callContrail(ctx, 'tools.atmo.chat.space.putRecord', { body: input });
}

export async function spaceListRecords(
	ctx: AuthedCallContext,
	query: { spaceUri: string; collection: string; limit?: number; cursor?: string }
): Promise<{
	records: Array<{
		spaceUri: string;
		collection: string;
		authorDid: string;
		rkey: string;
		cid: string | null;
		record: Record<string, unknown>;
		createdAt: number;
	}>;
	cursor?: string;
}> {
	const q: Record<string, string> = {
		spaceUri: query.spaceUri,
		collection: query.collection
	};
	if (query.limit) q.limit = String(query.limit);
	if (query.cursor) q.cursor = query.cursor;
	return callContrail(ctx, 'tools.atmo.chat.space.listRecords', { query: q });
}

// --- members ---------------------------------------------------------------

export async function listSpaceMembers(
	ctx: AuthedCallContext,
	query: { spaceUri: string; flatten?: boolean }
): Promise<
	| { members: Array<{ did: string; addedAt: number }> }
	| {
			rows: Array<{
				subject: { did?: string; spaceUri?: string };
				accessLevel: string;
				grantedBy: string;
				grantedAt: number;
			}>;
	  }
> {
	const q: Record<string, string> = { spaceUri: query.spaceUri };
	if (query.flatten) q.flatten = 'true';
	return callContrail(ctx, 'tools.atmo.chat.community.space.listMembers', { query: q });
}

export async function whoami(
	ctx: AuthedCallContext,
	query: { spaceUri: string }
): Promise<{ spaceUri: string; accessLevel: string | null }> {
	return callContrail(ctx, 'tools.atmo.chat.community.space.whoami', { query });
}

// --- realtime --------------------------------------------------------------

export async function getRealtimeTicket(
	ctx: AuthedCallContext,
	input: { topic: string }
): Promise<{ ticket: string; topics: string[]; expiresAt: number }> {
	return callContrail(ctx, 'tools.atmo.chat.realtime.ticket', { body: input });
}

// --- invites ---------------------------------------------------------------

export interface InviteView {
	tokenHash: string;
	spaceUri: string;
	accessLevel: 'member' | 'manager' | 'admin' | 'owner';
	createdBy: string;
	createdAt: number;
	expiresAt: number | null;
	maxUses: number | null;
	usedCount: number;
	revokedAt: number | null;
	note: string | null;
}

export async function createCommunityInvite(
	ctx: AuthedCallContext,
	input: {
		spaceUri: string;
		accessLevel: 'member' | 'manager' | 'admin' | 'owner';
		expiresAt?: number;
		maxUses?: number;
		note?: string;
	}
): Promise<{
	token: string;
	tokenHash: string;
	spaceUri: string;
	accessLevel: string;
	expiresAt: number | null;
	maxUses: number | null;
	createdAt: number;
}> {
	return callContrail(ctx, 'tools.atmo.chat.community.invite.create', { body: input });
}

export async function listCommunityInvites(
	ctx: AuthedCallContext,
	query: { spaceUri: string; includeRevoked?: boolean }
): Promise<{ invites: InviteView[] }> {
	const q: Record<string, string> = { spaceUri: query.spaceUri };
	if (query.includeRevoked) q.includeRevoked = 'true';
	return callContrail(ctx, 'tools.atmo.chat.community.invite.list', { query: q });
}

export async function revokeCommunityInvite(
	ctx: AuthedCallContext,
	input: { tokenHash: string }
): Promise<{ ok: true }> {
	return callContrail(ctx, 'tools.atmo.chat.community.invite.revoke', { body: input });
}

export async function redeemCommunityInvite(
	ctx: AuthedCallContext,
	input: { token: string }
): Promise<{ spaceUri: string; accessLevel: string; communityDid: string }> {
	return callContrail(ctx, 'tools.atmo.chat.community.invite.redeem', { body: input });
}

// --- blobs -----------------------------------------------------------------

export interface BlobRef {
	$type: 'blob';
	ref: { $link: string };
	mimeType: string;
	size: number;
}

/** Upload raw bytes to a space's blob store. Unlike the other helpers this one
 *  uses a binary body (the raw bytes) rather than JSON, so we build the
 *  Request ourselves. Returns the blob ref for use in a record field. */
export async function uploadBlob(
	ctx: AuthedCallContext,
	input: { spaceUri: string; mimeType: string; bytes: Uint8Array }
): Promise<BlobRef> {
	const method = 'tools.atmo.chat.space.uploadBlob';
	const jwt = ctx.env.DEV_AUTH === '1' ? 'dev' : await mintServiceAuthForUpload(ctx, method);
	const url = new URL(`http://localhost/xrpc/${method}`);
	url.searchParams.set('spaceUri', input.spaceUri);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${jwt}`,
		'Content-Type': input.mimeType,
		'Content-Length': String(input.bytes.byteLength)
	};
	if (ctx.env.DEV_AUTH === '1') headers['X-Dev-Did'] = ctx.did;

	const req = new Request(url, {
		method: 'POST',
		headers,
		body: new Blob([new Uint8Array(input.bytes)], { type: input.mimeType })
	});
	const res = await dispatch(req, ctx.env);
	const text = await res.text();
	const json = text ? JSON.parse(text) : {};
	if (!res.ok) throw new Error(`${method} failed (${res.status}): ${text}`);
	return (json as { blob: BlobRef }).blob;
}

async function mintServiceAuthForUpload(
	ctx: AuthedCallContext,
	lxm: string,
	expSeconds = 60
): Promise<string> {
	const res = await ctx.client.get('com.atproto.server.getServiceAuth', {
		params: {
			aud: ctx.env.SERVICE_DID as `did:${string}:${string}`,
			lxm: lxm as `${string}.${string}.${string}`,
			exp: Math.floor(Date.now() / 1000) + expSeconds
		}
	});
	if (!res.ok) throw new Error('getServiceAuth failed');
	return (res.data as { token: string }).token;
}
