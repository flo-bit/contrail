<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import LoginForm from '$lib/LoginForm.svelte';
  import { when } from '$lib/format';
  let { data, form } = $props();
  let busy = $state(false);
  let copied = $state(false);
  let linkInput = $state<HTMLInputElement>();
  const ownStatus = $derived(data.details?.attendees.find((entry) => entry.did === data.did)?.status);
  const submit: SubmitFunction = () => {
    busy = true;
    copied = false;
    return async ({ update }) => { try { await update({ reset: false }); } finally { busy = false; } };
  };
  async function copy() {
    if (!form?.link) return;
    try { await navigator.clipboard.writeText(form.link); copied = true; }
    catch { linkInput?.select(); }
  }
</script>

<a href="/" class="back">← Events</a>
{#if !data.did}
  <h1>Private event</h1>
  <LoginForm returnTo={data.address.path} />
{:else if data.details}
  <h1>{data.details.event.name}</h1>
  <p class="muted">{when(data.details.event.startsAt)}</p>
  {#if data.details.event.description}<p class="description">{data.details.event.description}</p>{/if}
  {#if form?.message}<p role="alert">{form.message}</p>{/if}
  {#if form?.notice}<p role="status">{form.notice}</p>{/if}
  <section>
    <h2>Your RSVP</h2>
    <form method="POST" action="?/rsvp" use:enhance={submit} class="button-row">
      <button name="status" value="going" class:chosen={ownStatus === 'going'} aria-pressed={ownStatus === 'going'} disabled={busy}>Going</button>
      <button name="status" value="notgoing" class:chosen={ownStatus === 'notgoing'} aria-pressed={ownStatus === 'notgoing'} disabled={busy}>Can’t go</button>
    </form>
  </section>
  {#if data.did === data.address.owner}
    <section>
      <h2>Invite someone</h2>
      {#if form?.link}
        <label for="invite-link" class="sr-only">Invitation link</label>
        <div class="input-row">
          <input id="invite-link" readonly value={form.link} bind:this={linkInput} onclick={(event) => event.currentTarget.select()} />
          <button type="button" onclick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
        </div>
        <form method="POST" action="?/revoke" use:enhance={submit} class="revoke-row">
          <input type="hidden" name="rkey" value={form.rkey} />
          <button class="text-button" disabled={busy}>Revoke link</button>
        </form>
      {:else}
        <form method="POST" action="?/invite" use:enhance={submit}>
          <button disabled={busy}>{busy ? 'Working…' : 'Create invite link'}</button>
        </form>
      {/if}
    </section>
  {/if}
  <section>
    <div class="heading-row"><h2>Responses</h2><a href={data.address.path} data-sveltekit-reload class="small">Refresh</a></div>
    {#if data.details.attendees.length}
      <ul class="responses">
        {#each data.details.attendees as attendee (attendee.did)}
          <li><span class="account-id" title={attendee.did}>{attendee.did === data.did ? 'You' : attendee.did}</span><span class="muted small">{attendee.status === 'going' ? 'Going' : attendee.status === 'notgoing' ? 'Can’t go' : attendee.status === 'interested' ? 'Interested' : 'Responded'}</span></li>
        {/each}
      </ul>
    {:else}<p class="muted small">No RSVPs yet.</p>{/if}
    {#if data.details.truncated}<p class="muted small">Showing the first 100 responses.</p>{/if}
  </section>
{:else}
  <h1>Event unavailable</h1>
  <p role="alert">{data.message}</p>
  <a href={data.address.path} data-sveltekit-reload>Try again</a>
{/if}
