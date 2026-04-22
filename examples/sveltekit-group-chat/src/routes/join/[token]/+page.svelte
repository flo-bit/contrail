<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button, Heading } from '@foxui/core';
	import { user } from '$lib/atproto';
	import { atProtoLoginModalState } from '$lib/atproto/ui/LoginModal.svelte';
	import { redeemInvite } from '$lib/rooms/invites.remote';

	const token = $derived(page.params.token!);

	let redeeming = $state(false);
	let err = $state<string | null>(null);

	async function accept() {
		redeeming = true;
		err = null;
		try {
			const res = await redeemInvite({ token });
			await goto(
				resolve('/c/[communityDid]', { communityDid: res.communityDid })
			);
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			redeeming = false;
		}
	}
</script>

<div class="mx-auto my-24 max-w-md px-4">
	<Heading>Join server</Heading>

	{#if !user.isLoggedIn}
		<p class="text-base-500 mt-3 text-sm">
			Sign in with your atproto account to accept this invite.
		</p>
		<div class="mt-4">
			<Button onclick={() => (atProtoLoginModalState.open = true)}>Sign in</Button>
		</div>
	{:else}
		<p class="text-base-500 mt-3 text-sm">
			You're signed in as <span class="font-medium">{user.profile?.handle ?? user.did}</span>.
			Accepting will add you to the server's members.
		</p>
		<div class="mt-6 flex gap-2">
			<Button onclick={accept} disabled={redeeming}>
				{redeeming ? 'Joining…' : 'Accept invite'}
			</Button>
			<Button variant="ghost" onclick={() => goto(resolve('/'))}>Cancel</Button>
		</div>
		{#if err}
			<div class="mt-4 rounded-xl border border-red-500 p-2 text-sm text-red-500">{err}</div>
		{/if}
	{/if}
</div>
