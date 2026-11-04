<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import LoginForm from '$lib/LoginForm.svelte';
  import { when } from '$lib/format';
  let { data, form } = $props();
  let creating = $state(false);
  let busy = $state(false);
  let localTime = $state('');
  const submit: SubmitFunction = () => {
    busy = true;
    return async ({ update }) => { try { await update({ reset: false }); } finally { busy = false; } };
  };
</script>

{#if !data.did}
  <h1>Private events</h1>
  <LoginForm />
{:else}
  <div class="heading-row">
    <h1>Events</h1>
    {#if data.events.length && !creating}<button onclick={() => { creating = true; }}>New event</button>{/if}
  </div>
  {#if data.message}<p role="alert">{data.message}</p>{/if}
  {#if data.unavailable}<p role="status" class="muted">Some events couldn’t be loaded. Refresh to try again.</p>{/if}
  {#if form?.message}<p role="alert">{form.message}</p>{/if}
  {#if creating || !data.events.length}
    <form method="POST" action="?/create" use:enhance={submit} class="stack event-form">
      <h2>New event</h2>
      <label for="name">Name</label>
      <input id="name" name="name" placeholder="Dinner on Friday" required maxlength="120" />
      <label for="when">When <span class="muted small">(optional)</span></label>
      <input id="when" type="datetime-local" bind:value={localTime} />
      <input type="hidden" name="startsAt" value={localTime && Number.isFinite(Date.parse(localTime)) ? new Date(localTime).toISOString() : ''} />
      <label for="description">Details <span class="muted small">(optional)</span></label>
      <textarea id="description" name="description" rows="3" maxlength="2000"></textarea>
      <div class="button-row">
        <button class="primary" disabled={busy}>{busy ? 'Creating…' : 'Create private event'}</button>
        {#if data.events.length}<button type="button" class="text-button" onclick={() => { creating = false; }} disabled={busy}>Cancel</button>{/if}
      </div>
    </form>
  {/if}
  {#if data.events.length}
    <ul class="event-list">
      {#each data.events as event (event.path)}
        <li><a href={event.path}><strong>{event.name}</strong><span class="muted small">{when(event.startsAt)}{event.hosting ? ' · Hosting' : ''}</span></a></li>
      {/each}
    </ul>
  {/if}
  {#if data.truncated}<p class="muted small">Showing the first 20 spaces on your PDS.</p>{/if}
{/if}
