<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Button, Input, Heading } from '@foxui/core';
	import { RelativeTime } from '@foxui/time';
	import { actorToDid } from '$lib/atproto/methods';
	import type { Handle } from '@atcute/lexicons';
	import { grantMember, revokeMember, setMemberLevel } from '$lib/rooms/rooms.remote';
	import { displayName, handleOf } from '$lib/rooms/profiles.svelte';

	let { data } = $props();

	let handleInput = $state('');
	let addingErr = $state<string | null>(null);
	let adding = $state(false);

	const LEVELS = ['member', 'manager', 'admin', 'owner'] as const;

	async function addMember(e: SubmitEvent) {
		e.preventDefault();
		const h = handleInput.trim();
		if (!h) return;
		adding = true;
		addingErr = null;
		try {
			let did: string;
			if (h.startsWith('did:')) {
				did = h;
			} else {
				did = await actorToDid(h as unknown as Handle);
			}
			await grantMember({
				spaceUri: data.membersUri,
				did,
				accessLevel: 'member'
			});
			handleInput = '';
			await invalidateAll();
		} catch (err) {
			addingErr = err instanceof Error ? err.message : String(err);
		} finally {
			adding = false;
		}
	}

	async function changeLevel(did: string, level: (typeof LEVELS)[number]) {
		try {
			await setMemberLevel({
				spaceUri: data.membersUri,
				did,
				accessLevel: level
			});
			await invalidateAll();
		} catch (err) {
			console.error(err);
		}
	}

	async function remove(did: string) {
		if (!confirm(`Remove ${did.slice(0, 20)}… from this server?`)) return;
		try {
			await revokeMember({ spaceUri: data.membersUri, did });
			await invalidateAll();
		} catch (err) {
			console.error(err);
		}
	}
</script>

<div class="flex-1 overflow-y-auto p-6">
	<div class="mx-auto max-w-2xl">
		<Heading>Members</Heading>
		<p class="text-base-500 mt-1 text-sm">
			Add members by handle (<code>alice.bsky.social</code>) or DID. Membership here gives access
			to all public channels.
		</p>

		<form onsubmit={addMember} class="mt-6 flex gap-2">
			<Input
				bind:value={handleInput}
				placeholder="alice.bsky.social or did:plc:..."
				class="flex-1"
			/>
			<Button type="submit" disabled={adding || !handleInput.trim()}>
				{adding ? '…' : 'Add'}
			</Button>
		</form>
		{#if addingErr}
			<div class="mt-2 text-xs text-red-500">{addingErr}</div>
		{/if}

		<div class="mt-8">
			{#if data.members.length === 0}
				<p class="text-base-500 text-sm">No members yet.</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each data.members as m (m.did ?? m.spaceUri)}
						<li
							class="bg-base-100 dark:bg-base-900 flex items-center justify-between rounded-2xl border p-3"
						>
							<div class="min-w-0">
								{#if m.did}
									<div class="truncate text-sm font-medium">{displayName(m.did)}</div>
									{#if handleOf(m.did) && handleOf(m.did) !== displayName(m.did)}
										<div class="text-base-500 truncate text-xs">@{handleOf(m.did)}</div>
									{:else}
										<div class="text-base-400 truncate font-mono text-xs">{m.did}</div>
									{/if}
								{:else if m.spaceUri}
									<div class="truncate text-sm">
										Role: <span class="font-mono">{m.spaceUri}</span>
									</div>
								{/if}
								<div class="text-base-500 mt-0.5 text-xs">
									granted <RelativeTime date={new Date(m.grantedAt)} locale="en-US" />
								</div>
							</div>
							<div class="flex items-center gap-2">
								{#if m.did}
									<select
										class="bg-base-100 dark:bg-base-900 rounded-xl border px-2 py-1 text-sm"
										value={m.accessLevel}
										onchange={(e) =>
											changeLevel(m.did!, (e.currentTarget as HTMLSelectElement).value as (typeof LEVELS)[number])}
									>
										{#each LEVELS as lv (lv)}
											<option value={lv}>{lv}</option>
										{/each}
									</select>
									<Button variant="ghost" size="sm" onclick={() => remove(m.did!)}>
										Remove
									</Button>
								{:else}
									<span class="text-base-500 text-sm">{m.accessLevel}</span>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>
