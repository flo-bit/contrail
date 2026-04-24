/** Thin SvelteKit remote-command wrappers around contrail's community.invite.*
 *  XRPCs. Contrail owns the token storage, atomic redemption, and access-level
 *  authorization checks. */

import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import type { Client } from '@atcute/client';
import {
	createCommunityInvite,
	redeemCommunityInvite,
	revokeCommunityInvite
} from './server';

function requireAuthed() {
	const event = getRequestEvent();
	const env = event.platform?.env;
	const client = event.locals.client;
	const did = event.locals.did;
	if (!env) error(500, 'platform env unavailable');
	if (!client || !did) error(401, 'Not authenticated');
	return { env, client: client as Client, did: did as string };
}

const AccessLevel = v.picklist(['member', 'manager', 'admin', 'owner']);

const CreateInviteInput = v.object({
	spaceUri: v.pipe(v.string(), v.minLength(1)),
	accessLevel: v.optional(AccessLevel),
	expiresInMinutes: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(60 * 24 * 90))),
	maxUses: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(10000))),
	note: v.optional(v.pipe(v.string(), v.maxLength(500)))
});

export const createInvite = command(CreateInviteInput, async (input) => {
	const ctx = requireAuthed();
	const expiresAt =
		input.expiresInMinutes != null ? Date.now() + input.expiresInMinutes * 60_000 : undefined;
	const res = await createCommunityInvite(ctx, {
		spaceUri: input.spaceUri,
		accessLevel: input.accessLevel ?? 'member',
		expiresAt,
		maxUses: input.maxUses,
		note: input.note
	});
	return { token: res.token, tokenHash: res.tokenHash };
});

const RevokeInviteInput = v.object({
	tokenHash: v.pipe(v.string(), v.minLength(1))
});

export const revokeInvite = command(RevokeInviteInput, async (input) => {
	const ctx = requireAuthed();
	return revokeCommunityInvite(ctx, { tokenHash: input.tokenHash });
});

const RedeemInviteInput = v.object({
	token: v.pipe(v.string(), v.minLength(8))
});

export const redeemInvite = command(RedeemInviteInput, async (input) => {
	const ctx = requireAuthed();
	return redeemCommunityInvite(ctx, { token: input.token });
});
