<script lang="ts">
  import '../app.css';
  let { data, children } = $props();
</script>

<svelte:head><title>Spaces — private events</title></svelte:head>
<header class="app-header">
  <a href="/" class="brand">Spaces</a>
  {#if data.did}
    <div class="account">
      <span class="muted small account-id" title={data.did}>{data.did}</span>
      <form action="/logout" method="POST"><button class="text-button">Sign out</button></form>
    </div>
  {/if}
</header>
<main>{@render children()}</main>
