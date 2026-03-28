<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { user, logout, uploadBlob } from '$lib/atproto';
	import { Button, Avatar } from '@foxui/core';
	import { atProtoLoginModalState } from '@foxui/social';
	import { RelativeTime } from '@foxui/time';

	import { createTID, getCDNImageBlobUrl } from '$lib/atproto/methods';
	import { putRecord } from '$lib/atproto/server/repo.remote';

	let { data } = $props();

	let uploading = $state(false);
	let fileInput: HTMLInputElement = $state()!;

	async function handleImageUpload() {
		const file = fileInput?.files?.[0];
		if (!file) return;

		uploading = true;
		try {
			const blobRef = await uploadBlob({ blob: file });
			await putRecord({
				rkey: createTID(),
				collection: 'social.atmo.test.blob',
				record: {
					blob: blobRef,
					createdAt: new Date().toISOString()
				}
			});
			fileInput.value = '';
			await invalidateAll();
		} catch (e) {
			console.error('Upload failed:', e);
		} finally {
			uploading = false;
		}
	}
</script>

<div class="mx-auto my-4 max-w-3xl px-4 md:my-32">
	<h1 class="text-3xl font-bold">blob upload</h1>

	<a href="/" class="dark:text-accent-500 mt-2 text-sm text-rose-600">back to home</a>

	{#if !user.isLoggedIn}
		<div class="mt-8 text-sm">not logged in</div>
		<Button class="mt-4" onclick={() => atProtoLoginModalState.show()}>Login</Button>
	{/if}

	{#if user.isLoggedIn}
		<div class="mt-8 text-sm">signed in as</div>

		<div class="mt-2 flex gap-1 font-semibold">
			<Avatar src={user.profile?.avatar} />
			<span>{user.profile?.displayName || user.profile?.handle}</span>
		</div>

		<div class="my-4 text-sm">
			<div class="mt-2 flex items-center gap-2">
				<input
					bind:this={fileInput}
					type="file"
					accept="image/*"
					onchange={handleImageUpload}
					disabled={uploading}
					class="text-sm file:mr-2 file:rounded file:border-0 file:bg-rose-100 file:px-3 file:py-1 file:text-sm file:text-rose-700 dark:file:bg-rose-900 dark:file:text-rose-200"
				/>
				{#if uploading}
					<span class="text-base-400 text-sm">uploading...</span>
				{/if}
			</div>

			{#if data.blobs.length > 0}
				<div class="mt-4 text-sm">Uploaded blobs:</div>
				<div class="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
					{#each data.blobs as blob (blob.rkey)}
						<div class="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700">
							<img
								src={getCDNImageBlobUrl({ did: user.did ?? undefined, blob: blob.blob })}
								alt="uploaded blob"
								class="aspect-square w-full object-cover"
							/>
							<div class="text-base-400 dark:text-base-500 p-1 text-center text-xs">
								<RelativeTime date={new Date(blob.createdAt)} locale="en-US" />
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<Button class="mt-4" onclick={() => logout()}>Sign Out</Button>
	{/if}
</div>
