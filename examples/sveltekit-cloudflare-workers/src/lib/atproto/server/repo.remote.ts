import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { collections } from '../settings';

// Validate collection format and check against allowed list from settings
const collectionSchema = v.pipe(
	v.string(),
	v.regex(/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*){2,}$/),
	v.check((c) => collections.includes(c as (typeof collections)[number]), 'Collection not in allowed list')
);

// AT Protocol rkey: TID, 'self', or other valid record keys (alphanumeric, dash, underscore, dot)
const rkeySchema = v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/)));

export const putRecord = command(
	v.object({
		collection: collectionSchema,
		rkey: rkeySchema,
		record: v.record(v.string(), v.unknown())
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const response = await locals.client.post('com.atproto.repo.putRecord', {
			input: {
				collection: input.collection as `${string}.${string}.${string}`,
				repo: locals.did,
				rkey: input.rkey || 'self',
				record: input.record
			}
		});

		return response.data;
	}
);

export const deleteRecord = command(
	v.object({
		collection: collectionSchema,
		rkey: rkeySchema
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const response = await locals.client.post('com.atproto.repo.deleteRecord', {
			input: {
				collection: input.collection as `${string}.${string}.${string}`,
				repo: locals.did,
				rkey: input.rkey || 'self'
			}
		});

		return { ok: response.ok };
	}
);

export const uploadBlob = command(
	v.object({
		bytes: v.array(v.number()),
		mimeType: v.string()
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mimeType });

		const response = await locals.client.post('com.atproto.repo.uploadBlob', {
			params: { repo: locals.did },
			input: blob
		});

		if (!response.ok) error(500, 'Upload failed');

		return response.data.blob as {
			$type: 'blob';
			ref: { $link: string };
			mimeType: string;
			size: number;
		};
	}
);
