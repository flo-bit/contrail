<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Button, Heading, Input } from '@foxui/core';
	import { RelativeTime } from '@foxui/time';
	import { createInvite, revokeInvite } from '$lib/rooms/invites.remote';

	let { data } = $props();

	let expiresMinutes = $state<number | ''>(60 * 24); // 1 day
	let maxUses = $state<number | ''>(1);
	let note = $state('');
	let creating = $state(false);
	let lastCreated = $state<{ token: string; url: string } | null>(null);
	let err = $state<string | null>(null);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		creating = true;
		err = null;
		try {
			const res = await createInvite({
				spaceUri: data.membersUri,
				expiresInMinutes: expiresMinutes === '' ? undefined : Number(expiresMinutes),
				maxUses: maxUses === '' ? undefined : Number(maxUses),
				note: note.trim() || undefined
			});
			const url = `${window.location.origin}/join/${res.token}`;
			lastCreated = { token: res.token, url };
			note = '';
			await invalidateAll();
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			creating = false;
		}
	}

	async function revoke(tokenHash: string) {
		if (!confirm('Revoke this invite? Existing unused tokens will stop working.')) return;
		try {
			await revokeInvite({ tokenHash });
			await invalidateAll();
		} catch (e) {
			console.error(e);
		}
	}

	function copy(text: string) {
		void navigator.clipboard.writeText(text);
	}
</script>

<div class="flex-1 overflow-y-auto p-6">
	<div class="mx-auto max-w-2xl">
		<Heading>Invites</Heading>
		<p class="text-base-500 mt-1 text-sm">
			Share an invite link to let new members join. They'll be added to this server's
			<code>members</code> role on redemption.
		</p>

		<form onsubmit={create} class="mt-6 grid grid-cols-2 gap-3">
			<label class="flex flex-col gap-1 text-sm">
				Expires in (minutes)
				<Input type="number" min="1" bind:value={expiresMinutes} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				Max uses (blank = unlimited)
				<Input type="number" min="1" bind:value={maxUses} />
			</label>
			<label class="col-span-2 flex flex-col gap-1 text-sm">
				Note (optional, only visible to admins)
				<Input bind:value={note} maxlength={500} />
			</label>
			{#if err}
				<div class="col-span-2 rounded-xl border border-red-500 p-2 text-xs text-red-500">
					{err}
				</div>
			{/if}
			<div class="col-span-2">
				<Button type="submit" disabled={creating}>
					{creating ? 'Creating…' : 'Create invite link'}
				</Button>
			</div>
		</form>

		{#if lastCreated}
			<div
				class="bg-accent-50 dark:bg-accent-950/40 border-accent-500/30 mt-4 flex items-center gap-3 rounded-2xl border p-3"
			>
				<div class="min-w-0 flex-1">
					<div class="text-xs font-semibold uppercase">New invite</div>
					<div class="mt-1 truncate font-mono text-xs">{lastCreated.url}</div>
				</div>
				<Button size="sm" onclick={() => copy(lastCreated!.url)}>Copy</Button>
			</div>
		{/if}

		<div class="mt-8">
			<h2 class="mb-3 text-sm font-semibold uppercase">Active invites</h2>
			{#if data.invites.length === 0}
				<p class="text-base-500 text-sm">No invites yet.</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each data.invites as inv (inv.id)}
						<li
							class="bg-base-100 dark:bg-base-900 flex items-center justify-between rounded-2xl border p-3"
						>
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<span class="font-mono text-xs">{inv.id}</span>
									{#if inv.revoked}
										<span
											class="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-500"
										>
											revoked
										</span>
									{:else if inv.expiresAt && inv.expiresAt < Date.now()}
										<span
											class="bg-base-300 dark:bg-base-700 rounded-full px-2 py-0.5 text-xs"
										>
											expired
										</span>
									{:else if inv.maxUses != null && inv.usedCount >= inv.maxUses}
										<span
											class="bg-base-300 dark:bg-base-700 rounded-full px-2 py-0.5 text-xs"
										>
											used up
										</span>
									{/if}
								</div>
								<div class="text-base-500 mt-1 text-xs">
									{inv.usedCount}
									{inv.maxUses != null ? `/ ${inv.maxUses}` : ''} used
									{#if inv.expiresAt}
										· expires <RelativeTime
											date={new Date(inv.expiresAt)}
											locale="en-US"
										/>
									{/if}
									{#if inv.note}· {inv.note}{/if}
								</div>
							</div>
							{#if !inv.revoked}
								<Button variant="ghost" size="sm" onclick={() => revoke(inv.tokenHash)}>
									Revoke
								</Button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>
