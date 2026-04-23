<script lang="ts">
	import { tick } from 'svelte';
	import { Button, Input, Navbar } from '@foxui/core';
	import { RelativeTime } from '@foxui/time';
	import { postMessage } from '$lib/rooms/rooms.remote';
	import { setCurrentChannel } from '$lib/rooms/realtime.svelte';
	import { markLastRead } from '$lib/rooms/unread.svelte';
	import { displayName } from '$lib/rooms/profiles.svelte';
	import { createWatchQuery } from '$lib/rooms/watch.svelte';
	import type { WatchRecord } from '@atmo-dev/contrail/sync';
	import { dev } from '$app/environment';
	import { setConnectionStatus, resetConnectionStatus } from '$lib/rooms/connection.svelte';

	let { data } = $props();

	let channel = $derived(data.channels.find((c) => c.key === data.channelKey));
	let channelName = $derived(channel?.name ?? data.channelKey);

	// Live message feed via contrail's watchRecords subscription. The engine
	// handles the snapshot + live merge; we just render its `records` array.
	// Sorted newest-first by default — flip to oldest-first for chat.
	//
	// The query is keyed strictly on spaceUri — recreating it on every
	// `data` identity change would tear down and rebuild the subscription on
	// unrelated page-data invalidations (e.g. channel list refresh), flashing
	// "Loading…" each time. Using a keyed effect here avoids that.
	let query = $state<ReturnType<typeof createWatchQuery> | null>(null);
	let currentUri: string | null = null;

	$effect(() => {
		const uri = data.spaceUri;
		if (uri === currentUri) return;
		query?.stop();
		currentUri = uri;
		query = createWatchQuery({
			url: `/xrpc/tools.atmo.chat.message.watchRecords?spaceUri=${encodeURIComponent(uri)}&limit=50`,
			transport: dev ? 'sse' : 'ws',
			fetchAuthToken: dev
				? undefined
				: async () => {
						const res = await fetch('/api/watch-token', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ lxm: 'tools.atmo.chat.message.watchRecords' })
						});
						if (!res.ok) throw new Error(`watch-token mint failed: ${res.status}`);
						const d = (await res.json()) as { token: string };
						return d.token;
					},
			compareRecords: (a: WatchRecord, b: WatchRecord) =>
				(a.time_us ?? 0) - (b.time_us ?? 0)
		});
	});

	// Final teardown on component unmount.
	$effect(() => {
		return () => {
			query?.stop();
			query = null;
			currentUri = null;
		};
	});

	// Unread / current-channel bookkeeping.
	$effect(() => {
		setCurrentChannel(data.spaceUri);
		markLastRead(data.spaceUri);
		return () => setCurrentChannel(null);
	});

	// Mirror the query's connection status into the shared store so the
	// layout's navbar can render a dot for it.
	$effect(() => {
		if (query) setConnectionStatus(query.status);
		return () => resetConnectionStatus();
	});

	// Project records to the shape the existing template expects.
	let messages = $derived(
		(query?.records ?? []).map((r) => {
			const rec = r.record as { text?: string; createdAt?: string; replyTo?: string };
			return {
				rkey: r.rkey,
				authorDid: r.did,
				text: rec.text ?? '',
				createdAt: rec.createdAt ?? '',
				replyTo: rec.replyTo
			};
		})
	);

	let scrollEl: HTMLDivElement | null = $state(null);
	let text = $state('');
	let sending = $state(false);
	let sendErr = $state<string | null>(null);

	$effect(() => {
		void messages.length;
		tick().then(() => {
			if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
		});
	});

	async function send(e: SubmitEvent) {
		e.preventDefault();
		const t = text.trim();
		if (!t) return;
		sending = true;
		sendErr = null;
		try {
			await postMessage({ spaceUri: data.spaceUri, text: t });
			text = '';
		} catch (err) {
			sendErr = err instanceof Error ? err.message : String(err);
		} finally {
			sending = false;
		}
	}

	$effect(() => {
		if (messages.length > 0) {
			markLastRead(data.spaceUri);
		}
	});
</script>

<div class="flex min-h-0 flex-1 flex-col pb-20">
	<div bind:this={scrollEl} class="flex-1 overflow-y-auto px-4 py-6">
		{#if messages.length === 0 && (query?.status === 'connecting' || query?.status === 'snapshot' || query?.status === 'idle')}
			<div class="text-base-500 text-center text-sm">Loading…</div>
		{:else if messages.length === 0}
			<div class="text-base-500 text-center text-sm">No messages yet. Say hi.</div>
		{:else}
			<ul class="flex flex-col gap-2">
				{#each messages as m (m.rkey)}
					<li
						class="max-w-2xl {m.authorDid === data.myDid ? 'self-end text-right' : 'self-start'}"
					>
						<div class="text-base-500 text-xs">
							<span class="font-medium">{displayName(m.authorDid)}</span>
							·
							<RelativeTime date={new Date(m.createdAt)} locale="en-US" />
						</div>
						<div
							class="{m.authorDid === data.myDid
								? 'bg-accent-500 text-white'
								: 'bg-base-200 dark:bg-base-800'} mt-1 inline-block rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap"
						>
							{m.text}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<Navbar hasSidebar class="top-auto bottom-1">
	<form onsubmit={send} class="flex w-full items-center gap-2">
		<Input
			class="flex-1"
			maxlength={4000}
			placeholder={`message #${channelName}`}
			bind:value={text}
		/>
		<Button type="submit" disabled={sending || !text.trim()}>
			{sending ? '…' : 'Send'}
		</Button>
	</form>
</Navbar>

{#if sendErr}
	<div class="fixed right-4 bottom-20 z-50 rounded-xl border border-red-500 bg-white p-2 text-xs text-red-500 dark:bg-black">
		{sendErr}
	</div>
{/if}
