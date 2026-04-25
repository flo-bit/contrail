<script lang="ts">
	import { setContext } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button, Input, Modal, Heading, Sidebar, Navbar } from '@foxui/core';
	import { user } from '$lib/atproto';
	import { createChannel } from '$lib/rooms/rooms.remote';
	import { createWatchQuery } from '$lib/rooms/watch.svelte';
	import { unread, resetUnread } from '$lib/rooms/unread.svelte';
	import { connectCommunityRealtime } from '$lib/rooms/realtime.svelte';
	import { connection, connectionIndicator } from '$lib/rooms/connection.svelte';
	import { parseSpaceUri } from '$lib/rooms/uri';
	import { CHANNELS_CTX, type ChannelMeta } from '$lib/rooms/channels-context';

	let { data, children } = $props();

	let newChannelOpen = $state(false);
	let newChannelName = $state('');
	let newChannelTopic = $state('');
	let newChannelPrivate = $state(false);
	let privateDids = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);

	// Live channel list. Derived from a cross-space watch on
	// `tools.atmo.chat.channel` records authored by the community DID —
	// the contrail resolver expands this to the subset of channel spaces
	// the caller has access to (owner or direct member or via delegation).
	let channelsQuery = $derived(
		createWatchQuery({
			endpoint: 'tools.atmo.chat.channel',
			params: { actor: data.communityDid as `did:${string}:${string}`, limit: 100 }
		})
	);

	function projectChannel(
		r: (typeof channelsQuery.records)[number]
	): ChannelMeta | null {
		const rec = r.value;
		if (!r.space || rec.communityDid !== data.communityDid || !rec.name) return null;
		if (!rec.createdAt) return null;
		let visibility: 'public' | 'private';
		if (rec.visibility === 'public') visibility = 'public';
		else if (rec.visibility === 'private') visibility = 'private';
		else return null;
		const parsed = parseSpaceUri(r.space);
		if (!parsed || parsed.key.startsWith('$') || parsed.key === 'members') return null;
		return {
			spaceUri: r.space,
			key: parsed.key,
			name: rec.name,
			topic: rec.topic,
			visibility,
			createdAt: rec.createdAt
		};
	}

	let channels: readonly ChannelMeta[] = $derived(
		channelsQuery.records
			.map(projectChannel)
			.filter((c): c is ChannelMeta => c !== null)
			.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
	);

	// Expose the live list to child pages ([channelKey], root) via context.
	setContext(CHANNELS_CTX, {
		get list() {
			return channels;
		}
	});

	let currentChannelKey = $derived(page.params.channelKey ?? null);
	let currentChannel = $derived(
		currentChannelKey ? (channels.find((c) => c.key === currentChannelKey) ?? null) : null
	);

	async function submitNewChannel(e: SubmitEvent) {
		e.preventDefault();
		if (!newChannelName.trim()) return;
		creating = true;
		createError = null;
		try {
			const dids = privateDids
				.split(/[\s,]+/)
				.map((s) => s.trim())
				.filter(Boolean);
			const res = await createChannel({
				communityDid: data.communityDid,
				name: newChannelName.trim(),
				topic: newChannelTopic.trim() || undefined,
				visibility: newChannelPrivate ? 'private' : 'public',
				memberDids: newChannelPrivate ? dids : undefined
			});
			newChannelOpen = false;
			newChannelName = '';
			newChannelTopic = '';
			privateDids = '';
			newChannelPrivate = false;
			// The live watch picks up the new channel record automatically,
			// but the caller's membership only lands after the grant completes,
			// and the resolver-expanded ticket is cached for ~120s. In the
			// common case the snapshot reconcile on next ticket refresh covers
			// it; for now, fire-and-forget.
			await goto(
				resolve('/c/[communityDid]/[channelKey]', {
					communityDid: data.communityDid,
					channelKey: res.channelKey
				})
			);
		} catch (err) {
			createError = err instanceof Error ? err.message : String(err);
		} finally {
			creating = false;
		}
	}

	$effect(() => {
		if (!user.isLoggedIn) return;
		const disconnect = connectCommunityRealtime(data.communityDid);
		return disconnect;
	});

	$effect(() => {
		if (currentChannelKey) {
			const ch = channels.find((c) => c.key === currentChannelKey);
			if (ch) resetUnread(ch.spaceUri);
		}
	});

	function closeMobileSidebar() {
		const el = typeof document !== 'undefined' && document.getElementById('mobile-menu');
		if (el && 'hidePopover' in el) (el as HTMLElement).hidePopover();
	}
</script>

<Navbar hasSidebar>
	<div class="flex min-w-0 items-center gap-2">
		<button
			type="button"
			popovertarget="mobile-menu"
			class="text-base-500 hover:text-base-700 dark:hover:text-base-200 -ml-1 p-1 lg:hidden"
			aria-label="open sidebar"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="currentColor"
				class="size-5"
			>
				<path
					fill-rule="evenodd"
					d="M3 9a.75.75 0 0 1 .75-.75h16.5a.75.75 0 0 1 0 1.5H3.75A.75.75 0 0 1 3 9Zm0 6.75a.75.75 0 0 1 .75-.75h16.5a.75.75 0 0 1 0 1.5H3.75a.75.75 0 0 1-.75-.75Z"
					clip-rule="evenodd"
				/>
			</svg>
		</button>

		{#if currentChannel}
			<div class="flex min-w-0 items-baseline gap-2">
				<span class="text-base-500">{currentChannel.visibility === 'private' ? '🔒' : '#'}</span>
				<span class="truncate font-semibold">{currentChannel.name}</span>
				{#if currentChannel.topic}
					<span class="text-base-500 hidden truncate text-sm sm:inline">
						{currentChannel.topic}
					</span>
				{/if}
			</div>
		{:else}
			<span class="truncate font-semibold">{data.server?.name ?? 'server'}</span>
		{/if}
	</div>

	{@const ind = connectionIndicator(connection.status)}
	<span
		class="flex items-center gap-1.5 text-xs"
		title={ind.label}
		aria-label={`Connection: ${ind.label}`}
	>
		<span
			class="size-2 rounded-full {ind.color === 'green'
				? 'bg-emerald-500'
				: ind.color === 'orange'
					? 'animate-pulse bg-amber-500'
					: ind.color === 'red'
						? 'bg-red-500'
						: 'bg-base-400'}"
		></span>
		<span class="text-base-500 hidden sm:inline">{ind.label}</span>
	</span>
</Navbar>

<Sidebar>
	<div class="flex h-full flex-col">
		<div class="border-base-200 dark:border-base-300/10 border-b p-4">
			<a
				href={resolve('/')}
				onclick={closeMobileSidebar}
				class="text-base-500 text-xs hover:underline"
			>
				← all servers
			</a>
			<div class="mt-2 flex items-center gap-2">
				{#if data.server?.iconUrl}
					<img
						src={data.server.iconUrl}
						alt=""
						class="bg-base-200 dark:bg-base-800 size-8 shrink-0 rounded-full object-cover"
					/>
				{/if}
				<div class="truncate font-semibold">{data.server?.name ?? 'server'}</div>
			</div>
			{#if data.server?.description}
				<div class="text-base-500 mt-1 line-clamp-2 text-xs">{data.server.description}</div>
			{/if}
		</div>

		<nav class="flex-1 overflow-y-auto p-2">
			<div class="mb-2 flex items-center justify-between px-2">
				<span class="text-base-500 text-xs font-semibold uppercase">channels</span>
				{#if data.isAdmin}
					<button
						class="text-base-500 hover:text-base-700 dark:hover:text-base-200 text-sm leading-none"
						aria-label="new channel"
						onclick={() => (newChannelOpen = true)}
					>
						+
					</button>
				{/if}
			</div>

			{#if channels.length === 0}
				<div class="text-base-500 px-2 py-1 text-xs">no channels yet</div>
			{:else}
				<ul class="flex flex-col gap-0.5">
					{#each channels as ch (ch.spaceUri)}
						{@const active = ch.key === currentChannelKey}
						{@const hasUnread = !active && (unread.counts[ch.spaceUri] ?? 0) > 0}
						<li>
							<Button
								variant="ghost"
								size="sm"
								href={resolve('/c/[communityDid]/[channelKey]', {
									communityDid: data.communityDid,
									channelKey: ch.key
								})}
								onclick={closeMobileSidebar}
								class="w-full justify-between font-normal backdrop-blur-none {active
									? 'font-semibold'
									: 'opacity-70 hover:opacity-100'}"
							>
								<span class="flex min-w-0 items-center gap-1.5 truncate">
									<span class="text-base-500">{ch.visibility === 'private' ? '🔒' : '#'}</span>
									<span class="truncate">{ch.name}</span>
								</span>
								{#if hasUnread}
									<span
										class="bg-accent-500 ml-2 inline-block h-2 w-2 shrink-0 rounded-full"
										aria-label="unread"
									></span>
								{/if}
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
		</nav>

		<div class="border-base-200 dark:border-base-300/10 flex flex-col gap-1 border-t p-2">
			{#if data.isAdmin}
				<a
					href={resolve('/c/[communityDid]/settings/members', {
						communityDid: data.communityDid
					})}
					onclick={closeMobileSidebar}
					class="hover:bg-base-200/50 dark:hover:bg-base-800/50 block rounded-lg px-2 py-1 text-sm"
				>
					Members
				</a>
				<a
					href={resolve('/c/[communityDid]/settings/invites', {
						communityDid: data.communityDid
					})}
					onclick={closeMobileSidebar}
					class="hover:bg-base-200/50 dark:hover:bg-base-800/50 block rounded-lg px-2 py-1 text-sm"
				>
					Invites
				</a>
			{/if}
			<div class="text-base-500 truncate px-2 py-1 text-xs">
				{user.profile?.handle ?? user.did}
			</div>
		</div>
	</div>
</Sidebar>

<main class="flex h-dvh min-w-0 flex-col overflow-hidden pt-18 lg:ml-74">
	{@render children?.()}
</main>

<Modal bind:open={newChannelOpen}>
	<div class="flex flex-col gap-3">
		<Heading>new channel</Heading>
		<form onsubmit={submitNewChannel} class="flex flex-col gap-3">
			<label class="flex flex-col gap-1 text-sm">
				Name
				<Input bind:value={newChannelName} placeholder="general" maxlength={128} required />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				Topic (optional)
				<Input bind:value={newChannelTopic} maxlength={512} />
			</label>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={newChannelPrivate} />
				Private — only specific people can see this
			</label>
			{#if newChannelPrivate}
				<label class="flex flex-col gap-1 text-sm">
					Member DIDs (comma or newline separated)
					<textarea
						class="bg-base-100 dark:bg-base-900 rounded-xl border px-3 py-2 text-sm"
						rows="3"
						bind:value={privateDids}
						placeholder="did:plc:..."
					></textarea>
				</label>
			{/if}
			{#if createError}
				<div class="rounded-xl border border-red-500 p-2 text-xs text-red-500">{createError}</div>
			{/if}
			<div class="flex gap-2">
				<Button type="submit" disabled={creating || !newChannelName.trim()}>
					{creating ? 'Creating…' : 'Create'}
				</Button>
				<Button type="button" variant="ghost" onclick={() => (newChannelOpen = false)}>
					Cancel
				</Button>
			</div>
		</form>
	</div>
</Modal>
