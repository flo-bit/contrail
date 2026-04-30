<script lang="ts">
	import '../app.css';
	import LoginModal from '$lib/atproto/ui/LoginModal.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<title>atproto-starter</title>
	<meta name="description" content="atproto app" />
	<link
		rel="icon"
		href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌱</text></svg>"
	/>
</svelte:head>

{@render children()}

<LoginModal />
