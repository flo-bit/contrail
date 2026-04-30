<script lang="ts" module>
	export const atProtoLoginModalState = $state({
		open: false
	});
</script>

<script lang="ts">
	import { login, signup } from '../auth.svelte';
	import { ALLOW_SIGNUP } from '../settings';

	let handle = $state('');
	let error = $state<string | null>(null);
	let loading = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);
	let cardEl = $state<HTMLDivElement | null>(null);

	function reset() {
		handle = '';
		error = null;
		loading = false;
	}

	function close() {
		atProtoLoginModalState.open = false;
		reset();
	}

	async function handleSubmit(event: Event) {
		event.preventDefault();
		if (loading) return;

		error = null;
		loading = true;
		try {
			await login(handle);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			loading = false;
		}
	}

	async function handleSignup() {
		if (loading) return;
		error = null;
		try {
			await signup();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			close();
		}
	}

	function handleFocusOut(event: FocusEvent) {
		const next = event.relatedTarget as Node | null;
		if (cardEl && next && cardEl.contains(next)) return;
		// If focus moved to nothing or outside the card, close.
		if (!next) return;
		close();
	}

	$effect(() => {
		if (atProtoLoginModalState.open) {
			// Focus input on open
			queueMicrotask(() => inputEl?.focus());
		}
	});
</script>

{#if atProtoLoginModalState.open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
		role="presentation"
	>
		<div
			bind:this={cardEl}
			class="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900 dark:text-gray-100"
			role="dialog"
			aria-modal="true"
			aria-labelledby="atproto-login-title"
			tabindex="-1"
			onfocusout={handleFocusOut}
		>
			<h2 id="atproto-login-title" class="mb-4 text-lg font-semibold">
				Sign in with atproto
			</h2>

			<form onsubmit={handleSubmit} class="flex flex-col gap-3">
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-gray-700 dark:text-gray-300">Handle or DID</span>
					<input
						bind:this={inputEl}
						bind:value={handle}
						type="text"
						autocomplete="username"
						placeholder="alice.bsky.social"
						class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
						disabled={loading}
					/>
				</label>

				{#if error}
					<p class="text-sm text-red-600 dark:text-red-400" role="alert">
						{error}
					</p>
				{/if}

				<button
					type="submit"
					disabled={loading || handle.trim().length === 0}
					class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus:ring-offset-gray-900"
				>
					{loading ? 'Signing in…' : 'Sign in'}
				</button>

				{#if ALLOW_SIGNUP}
					<button
						type="button"
						onclick={handleSignup}
						disabled={loading}
						class="rounded-md border border-gray-300 bg-transparent px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:ring-offset-gray-900"
					>
						Don't have an account? Sign up
					</button>
				{/if}
			</form>
		</div>
	</div>
{/if}
