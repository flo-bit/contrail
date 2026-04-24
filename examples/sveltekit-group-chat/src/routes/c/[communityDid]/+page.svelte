<script lang="ts">
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { CHANNELS_CTX, type ChannelsContext } from '$lib/rooms/channels-context';

	let { data } = $props();

	const channelsCtx = getContext<ChannelsContext>(CHANNELS_CTX);

	$effect(() => {
		const first = channelsCtx.list[0];
		if (first) {
			void goto(`/c/${encodeURIComponent(data.communityDid)}/${first.key}`, {
				replaceState: true
			});
		}
	});
</script>

<div class="flex flex-1 items-center justify-center p-8">
	{#if channelsCtx.list.length === 0}
		<div class="text-base-500 text-center">
			<p>No channels yet.</p>
			{#if data.isAdmin}
				<p class="mt-2 text-sm">Click <b>+</b> in the sidebar to create one.</p>
			{:else}
				<p class="mt-2 text-sm">Waiting for an admin to create a channel.</p>
			{/if}
		</div>
	{:else}
		<span class="text-base-500 text-sm">loading…</span>
	{/if}
</div>
