<script lang="ts" module>
	export const atProtoLoginModalState = $state({
		open: false
	});
</script>

<script lang="ts">
	import { AtprotoLoginModal } from '@foxui/social';
	import { login, signup } from '../auth.svelte';
</script>

<AtprotoLoginModal
	bind:open={atProtoLoginModalState.open}
	login={async (handle) => {
		await login(handle);
		return true;
	}}
	signup={async () => {
		signup();
		return true;
	}}
/>
