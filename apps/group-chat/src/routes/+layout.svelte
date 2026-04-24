<script lang="ts">
	import '../app.css';
	import { Head, ThemeToggle } from '@foxui/core';
	import LoginModal from '$lib/atproto/ui/LoginModal.svelte';
	import { profiles } from '$lib/rooms/profiles.svelte';

	let { data, children } = $props();

	// Seed the profile cache with the logged-in user so their own handle shows
	// up everywhere (members list, chat messages) without a separate fetch.
	$effect(() => {
		if (data.did && data.profile) {
			profiles[data.did] = {
				did: data.did,
				handle: data.profile.handle,
				displayName: data.profile.displayName,
				avatar: data.profile.avatar
			};
		}
	});
</script>

{@render children()}

<LoginModal />

<ThemeToggle class="absolute top-2 right-2" />

<Head
	title="chat demo"
	emojiFavicon="💬"
	description="contrail chat demo"
/>
