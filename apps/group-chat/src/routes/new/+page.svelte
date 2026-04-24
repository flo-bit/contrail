<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button, Heading, Input } from '@foxui/core';
	import { user } from '$lib/atproto';
	import { createCommunity } from '$lib/rooms/rooms.remote';

	let name = $state('');
	let description = $state('');
	let iconFile = $state<File | null>(null);
	let iconPreview = $state<string | null>(null);
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);
	let result = $state<{ communityDid: string; recoveryKey: unknown } | null>(null);

	function onIconPicked(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		if (!file) {
			iconFile = null;
			iconPreview = null;
			return;
		}
		if (file.size > 1_000_000) {
			errorMsg = 'Icon must be under 1 MB.';
			input.value = '';
			return;
		}
		iconFile = file;
		iconPreview = URL.createObjectURL(file);
	}

	async function fileToBase64(file: File): Promise<string> {
		const buf = await file.arrayBuffer();
		let binary = '';
		const bytes = new Uint8Array(buf);
		for (const b of bytes) binary += String.fromCharCode(b);
		return btoa(binary);
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!name.trim()) return;
		submitting = true;
		errorMsg = null;
		try {
			const icon = iconFile
				? { bytes: await fileToBase64(iconFile), mimeType: iconFile.type }
				: undefined;
			const res = await createCommunity({
				name: name.trim(),
				description: description.trim() || undefined,
				icon
			});
			result = { communityDid: res.communityDid, recoveryKey: res.recoveryKey };
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
	}

	function copyRecovery() {
		if (!result) return;
		void navigator.clipboard.writeText(JSON.stringify(result.recoveryKey, null, 2));
	}
</script>

<div class="mx-auto my-16 max-w-lg px-4">
	{#if !user.isLoggedIn}
		<p class="text-base-500">Please sign in first.</p>
	{:else if result}
		<Heading>Server created</Heading>
		<p class="text-base-500 mt-2 text-sm">
			This is the one and only chance to save your recovery key. If lost, ownership of this server
			cannot be recovered.
		</p>

		<pre
			class="bg-base-100 dark:bg-base-900 my-4 overflow-x-auto rounded-2xl border p-4 text-xs">{JSON.stringify(
				result.recoveryKey,
				null,
				2
			)}</pre>

		<div class="flex gap-2">
			<Button onclick={copyRecovery}>Copy recovery key</Button>
			<Button
				variant="secondary"
				onclick={() =>
					goto(
						resolve('/c/[communityDid]', {
							communityDid: result!.communityDid
						})
					)}
			>
				I've saved it — continue
			</Button>
		</div>
	{:else}
		<Heading>New server</Heading>
		<form onsubmit={submit} class="mt-6 flex flex-col gap-4">
			<label class="flex flex-col gap-1 text-sm">
				Name
				<Input bind:value={name} placeholder="Contrail rooms" maxlength={128} required />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				Description (optional)
				<Input bind:value={description} placeholder="a place for things" maxlength={2000} />
			</label>
			<div class="flex items-center gap-3">
				<label
					class="bg-base-200 dark:bg-base-800 flex size-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border"
				>
					{#if iconPreview}
						<img src={iconPreview} alt="icon" class="h-full w-full object-cover" />
					{:else}
						<span class="text-base-500 text-xs">icon</span>
					{/if}
					<input
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif"
						class="hidden"
						onchange={onIconPicked}
					/>
				</label>
				<div class="flex flex-col gap-1 text-xs">
					<span class="text-base-500">Server icon (optional)</span>
					<span class="text-base-400">PNG, JPG, WEBP, or GIF. Up to 1 MB.</span>
					{#if iconFile}
						<button
							type="button"
							class="text-red-500 hover:underline"
							onclick={() => {
								iconFile = null;
								iconPreview = null;
							}}
						>
							Remove
						</button>
					{/if}
				</div>
			</div>
			{#if errorMsg}
				<div class="rounded-xl border border-red-500 p-2 text-sm text-red-500">{errorMsg}</div>
			{/if}
			<div class="mt-2 flex gap-2">
				<Button type="submit" disabled={submitting || !name.trim()}>
					{submitting ? 'Creating…' : 'Create server'}
				</Button>
				<Button type="button" variant="ghost" onclick={() => goto(resolve('/'))}>Cancel</Button>
			</div>
		</form>
	{/if}
</div>
