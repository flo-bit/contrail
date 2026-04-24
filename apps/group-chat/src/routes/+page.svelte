<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button, Heading } from '@foxui/core';
	import { atProtoLoginModalState } from '$lib/atproto/ui/LoginModal.svelte';
	import { user, logout } from '$lib/atproto';
	import { RelativeTime } from '@foxui/time';

	let { data } = $props();
</script>

<div class="mx-auto my-16 max-w-2xl px-4">
	<div class="mb-8 flex items-center justify-between">
		<Heading>group chat</Heading>
		{#if user.isLoggedIn}
			<div class="flex items-center gap-2">
				<span class="text-base-500 text-sm">{user.profile?.handle ?? user.did}</span>
				<Button variant="ghost" size="sm" onclick={() => logout()}>Sign out</Button>
			</div>
		{:else}
			<Button size="sm" onclick={() => (atProtoLoginModalState.open = true)}>Sign in</Button>
		{/if}
	</div>

	{#if !user.isLoggedIn}
		<p class="text-base-500">
			Sign in with your atproto account to create a server or join one you've been invited to.
		</p>
	{:else}
		<div class="mb-6 flex items-center justify-between">
			<h2 class="text-lg font-semibold">Your servers</h2>
			<Button size="sm" onclick={() => goto('/new')}>+ New server</Button>
		</div>

		{#if data.servers.length === 0}
			<div class="text-base-500 rounded-2xl border border-dashed p-8 text-center text-sm">
				No servers yet. Create one to get started.
			</div>
		{:else}
			<ul class="grid gap-3 sm:grid-cols-2">
				{#each data.servers as server (server.communityDid)}
					<li>
						<a
							class="bg-base-100 dark:bg-base-800 hover:bg-base-200 dark:hover:bg-base-700 block rounded-2xl p-4 transition"
							href={`/c/${encodeURIComponent(server.communityDid)}`}
						>
							<div class="flex items-center gap-3">
								{#if server.iconUrl}
									<img
										src={server.iconUrl}
										alt=""
										class="bg-base-200 dark:bg-base-700 size-10 shrink-0 rounded-full object-cover"
									/>
								{:else}
									<div
										class="bg-base-200 dark:bg-base-700 text-base-500 flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
									>
										{server.name.slice(0, 1).toUpperCase()}
									</div>
								{/if}
								<div class="min-w-0">
									<div class="truncate font-semibold">{server.name}</div>
									<div class="text-base-400 text-xs">
										<RelativeTime date={new Date(server.createdAt)} locale="en-US" />
									</div>
								</div>
							</div>
							{#if server.description}
								<div class="text-base-500 mt-2 line-clamp-2 text-sm">{server.description}</div>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>
