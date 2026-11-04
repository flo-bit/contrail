<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { enhance } from '$app/forms';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import LoginForm from '$lib/LoginForm.svelte';
  import { when } from '$lib/format';
  let { data, form } = $props();
  let secret = $state('');
  let opening = $state(false);
  let joining = $state(false);
  let previewForm: HTMLFormElement;
  const preview = $derived(form?.preview ?? data.preview);
  const message = $derived(form?.message ?? data.message);
  const submitPreview: SubmitFunction = () => {
    opening = true;
    return async ({ update }) => { try { await update(); } finally { secret = ''; opening = false; } };
  };
  const submitJoin: SubmitFunction = () => {
    joining = true;
    return async ({ update }) => { try { await update(); } finally { joining = false; } };
  };
  onMount(() => {
    if (!window.location.hash) return;
    secret = window.location.hash.slice(1);
    opening = true;
    // Kit's root is not assigned during the initial onMount callback. Wait
    // for hydration before calling its shallow-routing API or submitting.
    void tick().then(() => {
      replaceState(page.url.pathname, page.state);
      previewForm.requestSubmit();
    });
  });
</script>

<form method="POST" action="?/preview" use:enhance={submitPreview} bind:this={previewForm} hidden>
  <input type="hidden" name="secret" value={secret} />
</form>
{#if opening}
  <p class="muted" role="status">Opening invitation…</p>
{:else if preview}
  <h1>{preview.name}</h1>
  <p class="muted">{when(preview.startsAt)}</p>
  {#if preview.description}<p class="description">{preview.description}</p>{/if}
  {#if message}<p role="alert">{message}</p>{/if}
  {#if data.did}
    <form method="POST" action="?/accept" use:enhance={submitJoin}>
      <button class="primary" disabled={joining}>{joining ? 'Joining…' : 'Join event'}</button>
    </form>
  {:else}
    <p class="muted">Sign in to join.</p>
    <LoginForm returnTo={page.url.pathname} />
  {/if}
{:else}
  <h1>Event invitation</h1>
  <p role="status">{message ?? 'Open the full invitation link to continue.'}</p>
{/if}
<noscript><p>JavaScript is needed to open invitation links.</p></noscript>
