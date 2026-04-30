<script lang="ts">
	import { user, logout } from '$lib/atproto';
	import { atProtoLoginModalState } from '$lib/atproto/ui/LoginModal.svelte';
</script>

<div class="mx-auto max-w-xl px-4 my-16">
	<h1 class="mb-4 text-3xl font-bold">atproto-starter</h1>

	{#if !user.isLoggedIn}
		<button
			class="my-4 inline-flex items-center justify-center rounded-lg bg-blue-600 px-6 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
			onclick={() => (atProtoLoginModalState.open = true)}
		>
			Sign In
		</button>
	{:else}
		<div class="my-4 flex items-center gap-2">
			<span class="text-gray-700 dark:text-gray-300 text-sm">
				Signed in as {user.profile?.handle ?? user.did}
			</span>
			<button
				class="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
				onclick={() => logout()}
			>
				Sign Out
			</button>
		</div>
	{/if}

	<!-- TODO: build your app here -->
</div>
