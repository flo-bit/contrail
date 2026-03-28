<script lang="ts">
	import { flip } from 'svelte/animate';
	import { scale } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { user, logout } from '$lib/atproto';
	import { Button } from '@foxui/core';
	import { GithubCorner, PopoverEmojiPicker } from '@foxui/social';
	import { RelativeTime } from '@foxui/time';
	import { JetstreamSubscription } from '@atcute/jetstream';

	import { createTID, getDetailedProfile } from '$lib/atproto/methods';
	import { putRecord } from '$lib/atproto/server/repo.remote';
	import { emojiToNotoAnimatedWebp } from '$lib/emojis';
	import { atProtoLoginModalState } from '$lib/atproto/ui/LoginModal.svelte';

	let { data } = $props();

	let open = $state(false);
	let localStatuses = $state<{ did: string; rkey: string; status: string; createdAt: string }[]>(
		[]
	);
	let liveStatuses = $state<{ did: string; rkey: string; status: string; createdAt: string }[]>([]);

	// Deduplication set seeded from server data
	// svelte-ignore state_referenced_locally
	let seenKeys = new SvelteSet<string>(data.statuses.map((s) => `${s.did}-${s.rkey}`));

	// Client-side profile cache seeded from server data
	// svelte-ignore state_referenced_locally
	let profiles = $state<Record<string, { handle: string; displayName?: string; avatar?: string }>>({
		...data.profiles
	});

	async function fetchProfile(did: string) {
		if (profiles[did]) return;
		try {
			const profile = await getDetailedProfile({ did: did as import('@atcute/lexicons').Did });
			if (!profile) return;
			profiles[did] = {
				handle: profile.handle,
				displayName: profile.displayName,
				avatar: profile.avatar
			};
		} catch {
			// ignore fetch errors
		}
	}

	let allStatuses = $derived([...localStatuses, ...liveStatuses, ...data.statuses]);

	// Jetstream subscription
	onMount(() => {
		const subscription = new JetstreamSubscription({
			url: 'wss://jetstream1.us-east.bsky.network',
			wantedCollections: ['xyz.statusphere.status']
		});

		const iterator = subscription[Symbol.asyncIterator]();

		(async () => {
			try {
				while (true) {
					const { value: event, done } = await iterator.next();
					if (done) break;

					if (event.kind !== 'commit') continue;
					if (event.commit.operation !== 'create') continue;

					const { did } = event;
					const { rkey, record } = event.commit as {
						rkey: string;
						record: { status: string; createdAt: string };
					};
					const key = `${did}-${rkey}`;

					if (seenKeys.has(key)) continue;
					seenKeys.add(key);

					await fetchProfile(did);

					liveStatuses = [
						{ did, rkey, status: record.status, createdAt: record.createdAt },
						...liveStatuses
					];
				}
			} catch {
				// subscription closed or errored
			}
		})();

		return () => {
			iterator.return!();
		};
	});
</script>

<div class="mx-auto max-w-xl px-4 my-16">
	<h1 class="mb-4 text-3xl font-bold">svelte + cloudflare workers statusphere</h1>

	<GithubCorner href="https://github.com/flo-bit/svelte-cloudflare-statusphere" />

	{#if !user.isLoggedIn}
		<Button class="my-4" size="lg" onclick={() => atProtoLoginModalState.open = true}
			>Login to post a status</Button
		>
	{:else}
		<div class="my-8 flex items-center gap-2">
			<PopoverEmojiPicker
				onpicked={async (emoji) => {
					const rkey = createTID();
					const createdAt = new Date().toISOString();
					const key = `${user.did!}-${rkey}`;
					seenKeys.add(key);
					localStatuses = [
						{ did: user.did!, rkey, status: emoji.unicode, createdAt },
						...localStatuses
					];
					open = false;
					await putRecord({
						rkey,
						collection: 'xyz.statusphere.status',
						record: {
							status: emoji.unicode,
							createdAt
						}
					});
				}}
				bind:open
			>
				{#snippet child({ props })}
					<Button size="lg" {...props}>Post a status</Button>
				{/snippet}
			</PopoverEmojiPicker>
			<Button variant="ghost" onclick={() => logout()}>Sign Out</Button>
		</div>
	{/if}

	{#if allStatuses.length > 0}
		<ul class="mt-4">
			{#each allStatuses as status, i (`${status.did}-${status.rkey}`)}
				{@const profile =
					profiles[status.did] ??
					(status.did === user.did && data.profile
						? { displayName: data.profile.displayName, handle: data.profile.handle }
						: null)}
				{@const animated = emojiToNotoAnimatedWebp(status.status)}
				<li class="flex items-center gap-3" animate:flip={{ duration: 300 }}>
					<div class="flex flex-col items-center">
						<div
							class="bg-base-200 dark:bg-base-950/50 border-base-400/50 dark:border-base-800 flex h-12 w-12 items-center inset-shadow-xs inset-shadow-base-800/10 dark:inset-shadow-black/60 justify-center rounded-full border text-2xl"
						>
							{#if animated}
								{#if i === 0}
									<img in:scale={{ duration: 300 }} src={animated} alt={status.status} class="h-7 w-7" />
								{:else}
									<img src={animated} alt={status.status} class="h-7 w-7" />
								{/if}
							{:else if i === 0}
								<span in:scale={{ duration: 300 }}>{status.status}</span>
							{:else}
								<span>{status.status}</span>
							{/if}
						</div>
						{#if i < allStatuses.length - 1}
							<div class="bg-base-400/50 dark:bg-base-800 min-h-3 w-px grow"></div>
						{/if}
					</div>
					<div class="flex items-center gap-1.5 pb-3">
						{#if profile}
							<span class="text-accent-500 text-sm font-medium"
								>{profile.displayName || profile.handle}</span
							>
						{:else}
							<span class="text-base-400 dark:text-base-500 text-sm"
								>{status.did.slice(0, 20)}...</span
							>
						{/if}
						<span class="text-base-400 dark:text-base-500 text-sm">&middot;</span>
						<span class="text-base-400 dark:text-base-500 text-sm">
							<RelativeTime date={new Date(status.createdAt)} locale="en-US" />
						</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
