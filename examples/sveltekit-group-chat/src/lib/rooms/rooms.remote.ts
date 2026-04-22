/** SvelteKit remote functions the browser can invoke directly. They run on
 *  the server, so they have access to `locals.client` (OAuth session) and
 *  `platform.env` (D1, DO, secrets). */

import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import type { Client } from '@atcute/client';
import {
	createSpace,
	communityPutRecord,
	grantAccess,
	mintCommunity,
	spacePutRecord,
	revokeAccess,
	setAccessLevel,
	uploadBlob
} from './server';
import { buildMembersUri } from './uri';

function requireAuthed() {
	const event = getRequestEvent();
	const env = event.platform?.env;
	const client = event.locals.client;
	const did = event.locals.did;
	if (!env) error(500, 'platform env unavailable');
	if (!client || !did) error(401, 'Not authenticated');
	return { env, client: client as Client, did: did as string };
}

// ---------------------------------------------------------------------------
// createCommunity — mint + bootstrap members space + write server record.
// Returns { communityDid, recoveryKey }. The UI must show recoveryKey once.
// ---------------------------------------------------------------------------

const CreateCommunityInput = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
	description: v.optional(v.pipe(v.string(), v.maxLength(2000))),
	handle: v.optional(v.pipe(v.string(), v.maxLength(256))),
	/** Optional icon blob ref. The bytes must already have been uploaded to
	 *  the community's members space via /api/blob-upload before this call —
	 *  but the members space doesn't exist yet at mint time, so the upload
	 *  flow is: createCommunity first, then separately upload+update. For
	 *  convenience, this endpoint also accepts an icon that was uploaded
	 *  *during* the same request — it stitches it in by reuploading into the
	 *  members space after creation. */
	icon: v.optional(
		v.object({
			/** Raw bytes as a base64 string — small enough to inline. */
			bytes: v.string(),
			mimeType: v.string()
		})
	)
});

export const createCommunity = command(CreateCommunityInput, async (input) => {
	const ctx = requireAuthed();

	const mint = await mintCommunity(ctx, input.handle ? { handle: input.handle } : {});
	const communityDid = mint.communityDid;

	const space = await createSpace(ctx, { communityDid, key: 'members' });
	const membersUri = space.space.uri;

	// If an icon was provided, upload it to the members space first, then
	// include its blob ref on the server record.
	let iconRef: import('./server').BlobRef | undefined;
	if (input.icon) {
		const bytes = Uint8Array.from(atob(input.icon.bytes), (c) => c.charCodeAt(0));
		iconRef = await uploadBlob(ctx, {
			spaceUri: membersUri,
			mimeType: input.icon.mimeType,
			bytes
		});
	}

	await communityPutRecord(ctx, {
		spaceUri: membersUri,
		collection: 'tools.atmo.chat.server',
		rkey: 'self',
		record: {
			communityDid,
			name: input.name,
			description: input.description,
			...(iconRef ? { icon: iconRef } : {}),
			createdAt: new Date().toISOString()
		}
	});

	return {
		communityDid,
		membersUri,
		recoveryKey: mint.recoveryKey
	};
});

// ---------------------------------------------------------------------------
// createChannel — new channel space + optional members-delegation (public) or
// direct DID grants (private) + channel record.
// ---------------------------------------------------------------------------

const CreateChannelInput = v.object({
	communityDid: v.pipe(v.string(), v.minLength(1)),
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
	topic: v.optional(v.pipe(v.string(), v.maxLength(512))),
	visibility: v.picklist(['public', 'private']),
	/** For private channels: DIDs to grant direct member access. */
	memberDids: v.optional(v.array(v.pipe(v.string(), v.minLength(1))))
});

export const createChannel = command(CreateChannelInput, async (input) => {
	const ctx = requireAuthed();

	const created = await createSpace(ctx, { communityDid: input.communityDid });
	const channelUri = created.space.uri;
	const channelKey = created.space.key;

	if (input.visibility === 'public') {
		await grantAccess(ctx, {
			spaceUri: channelUri,
			subject: { spaceUri: buildMembersUri(input.communityDid) },
			accessLevel: 'member'
		});
	} else {
		for (const did of input.memberDids ?? []) {
			// Ensure the user is in `members` too so they get the server header.
			// Ignore duplicates; grant is upsert.
			await grantAccess(ctx, {
				spaceUri: buildMembersUri(input.communityDid),
				subject: { did },
				accessLevel: 'member'
			}).catch(() => {});
			await grantAccess(ctx, {
				spaceUri: channelUri,
				subject: { did },
				accessLevel: 'member'
			});
		}
	}

	await communityPutRecord(ctx, {
		spaceUri: channelUri,
		collection: 'tools.atmo.chat.channel',
		rkey: 'self',
		record: {
			communityDid: input.communityDid,
			name: input.name,
			topic: input.topic,
			visibility: input.visibility,
			createdAt: new Date().toISOString()
		}
	});

	return { channelUri, channelKey };
});

// ---------------------------------------------------------------------------
// postMessage — append a chat message to a channel.
// ---------------------------------------------------------------------------

const PostMessageInput = v.object({
	spaceUri: v.pipe(v.string(), v.minLength(1)),
	text: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
	replyTo: v.optional(v.pipe(v.string(), v.minLength(1)))
});

export const postMessage = command(PostMessageInput, async (input) => {
	const ctx = requireAuthed();
	const res = await spacePutRecord(ctx, {
		spaceUri: input.spaceUri,
		collection: 'tools.atmo.chat.message',
		record: {
			text: input.text,
			createdAt: new Date().toISOString(),
			...(input.replyTo ? { replyTo: input.replyTo } : {})
		}
	});
	return res;
});

// ---------------------------------------------------------------------------
// grantMember / revokeMember / setMemberLevel — used in settings UI.
// ---------------------------------------------------------------------------

const GrantMemberInput = v.object({
	spaceUri: v.pipe(v.string(), v.minLength(1)),
	did: v.pipe(v.string(), v.minLength(1)),
	accessLevel: v.picklist(['member', 'manager', 'admin', 'owner'])
});

export const grantMember = command(GrantMemberInput, async (input) => {
	const ctx = requireAuthed();
	return grantAccess(ctx, {
		spaceUri: input.spaceUri,
		subject: { did: input.did },
		accessLevel: input.accessLevel
	});
});

const RevokeMemberInput = v.object({
	spaceUri: v.pipe(v.string(), v.minLength(1)),
	did: v.pipe(v.string(), v.minLength(1))
});

export const revokeMember = command(RevokeMemberInput, async (input) => {
	const ctx = requireAuthed();
	return revokeAccess(ctx, { spaceUri: input.spaceUri, subject: { did: input.did } });
});

export const setMemberLevel = command(GrantMemberInput, async (input) => {
	const ctx = requireAuthed();
	return setAccessLevel(ctx, {
		spaceUri: input.spaceUri,
		subject: { did: input.did },
		accessLevel: input.accessLevel
	});
});

