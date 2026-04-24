<script lang="ts">
	import { tick } from 'svelte';
	import { Button, Input, Navbar } from '@foxui/core';
	import { RelativeTime } from '@foxui/time';
	import { postMessage } from '$lib/rooms/rooms.remote';
	import { setCurrentChannel } from '$lib/rooms/realtime.svelte';
	import { markLastRead } from '$lib/rooms/unread.svelte';
	import { displayName } from '$lib/rooms/profiles.svelte';
	import { getContext } from 'svelte';
	import { createWatchQuery } from '$lib/rooms/watch.svelte';
	import { setConnectionStatus, resetConnectionStatus } from '$lib/rooms/connection.svelte';
	import { nextTid } from '@atmo-dev/contrail';
	import { CHANNELS_CTX, type ChannelsContext } from '$lib/rooms/channels-context';

	let { data } = $props();

	const channelsCtx = getContext<ChannelsContext>(CHANNELS_CTX);

	let channel = $derived(channelsCtx.list.find((c) => c.key === data.channelKey));
	let channelName = $derived(channel?.name ?? data.channelKey);

	// Live message feed. `$derived` recreates the query when spaceUri changes
	let messagesQuery = $derived(
		createWatchQuery({
			endpoint: 'tools.atmo.chat.message',
			params: { spaceUri: data.spaceUri, limit: 50 },
			compare: (a, b) => (a.time_us ?? 0) - (b.time_us ?? 0)
		})
	);

	// Unread / current-channel bookkeeping.
	$effect(() => {
		setCurrentChannel(data.spaceUri);
		markLastRead(data.spaceUri);
		return () => setCurrentChannel(null);
	});

	// Mirror the query's connection status into the shared store so the
	// layout's navbar can render a dot for it.
	$effect(() => {
		setConnectionStatus(messagesQuery.status);
		return () => resetConnectionStatus();
	});

	let messages = $derived(
		messagesQuery.records.map((r) => ({
			rkey: r.rkey,
			authorDid: r.did,
			text: r.value.text ?? '',
			createdAt: r.value.createdAt ?? '',
			replyTo: r.value.replyTo,
			pending: r.optimistic === 'pending',
			failed: r.optimistic === 'failed',
			error: r.optimisticError
		}))
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
		// Client-generated rkey lets the optimistic entry reconcile with the
		// stream's record.created event by identity.
		const rkey = nextTid();
		messagesQuery.addOptimistic({
			rkey,
			did: data.myDid,
			value: {
				$type: 'tools.atmo.chat.message',
				text: t,
				createdAt: new Date().toISOString()
			}
		});
		text = '';
		try {
			await postMessage({ spaceUri: data.spaceUri, rkey, text: t });
			// Success: leave the optimistic entry — the stream will replace it.
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			messagesQuery.markFailed(rkey, e);
			sendErr = e.message;
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
	{#if messages.length > 0 && (messagesQuery.status === 'connecting' || messagesQuery.status === 'snapshot')}
		<div
			class="text-base-500 absolute top-[4.5rem] left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-white/80 px-3 py-1 text-xs shadow-sm backdrop-blur dark:bg-black/80"
			aria-label="updating"
		>
			<svg class="size-3 animate-spin" viewBox="0 0 24 24" fill="none">
				<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-opacity="0.25" stroke-width="4" />
				<path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
			</svg>
			updating
		</div>
	{/if}
	<div bind:this={scrollEl} class="flex-1 overflow-y-auto px-4 py-6">
		{#if messages.length === 0 && (messagesQuery.status === 'connecting' || messagesQuery.status === 'snapshot' || messagesQuery.status === 'idle')}
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
							{#if m.pending}
								· <span class="text-base-400">sending…</span>
							{:else if m.failed}
								· <span class="text-red-500">failed{m.error ? ` (${m.error.message})` : ''}</span>
							{/if}
						</div>
						<div
							class="{m.authorDid === data.myDid
								? 'bg-accent-500 text-white'
								: 'bg-base-200 dark:bg-base-800'} mt-1 inline-block rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap {m.pending
								? 'opacity-60'
								: ''} {m.failed ? 'opacity-60 ring-1 ring-red-500' : ''}"
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
