<script lang="ts">
	import { goto } from '$app/navigation';
	let { data } = $props();

	$effect(() => {
		if (data.channels.length > 0) {
			void goto(`/c/${encodeURIComponent(data.communityDid)}/${data.channels[0].key}`, {
				replaceState: true
			});
		}
	});
</script>

<div class="flex flex-1 items-center justify-center p-8">
	{#if data.channels.length === 0}
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
