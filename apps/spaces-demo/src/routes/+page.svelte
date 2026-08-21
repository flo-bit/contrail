<script lang="ts">
  let { data, form } = $props();
  let loginHandle = $state("");
  let loggingIn = $state(false);
  let loginError = $state("");
  let replyUri = $state("");
  let replyCid = $state("");

  async function login() {
    loggingIn = true;
    loginError = "";
    try {
      const response = await fetch("/oauth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: loginHandle })
      });
      const body = await response.json();
      if (!response.ok || !body.url) throw new Error(body.message ?? body.error ?? "Login failed");
      window.location.href = body.url;
    } catch (error) {
      loginError = error instanceof Error ? error.message : "Login failed";
      loggingIn = false;
    }
  }

  async function logout() {
    await fetch("/oauth/logout", { method: "POST" });
    window.location.href = "/";
  }
</script>

<svelte:head>
  <title>Atmo Circle — Contrail Spaces demo</title>
  <meta name="description" content="A small private multi-writer AT Protocol Space projected by Contrail." />
</svelte:head>

<main>
  <header>
    <div>
      <h1>Atmo Circle</h1>
      <div class="subtle">private notes, verified and projected by Contrail</div>
    </div>
    {#if data.did}
      <button class="secondary" onclick={logout}>Sign out</button>
    {/if}
  </header>

  {#if form?.message}
    <div class="error">{form.message}</div>
  {/if}

  {#if !data.signedIn}
    <section class="card stack">
      <h2>Sign in to a Spaces-compatible PDS</h2>
      <input bind:value={loginHandle} placeholder="you.example.com" aria-label="Handle" />
      <button onclick={login} disabled={loggingIn || !loginHandle}>
        {loggingIn ? "Opening PDS…" : "Sign in"}
      </button>
      {#if loginError}<div class="error">{loginError}</div>{/if}
      <p class="subtle">This alpha only works with PDSes implementing the permissioned-data proposal.</p>
    </section>
  {:else}
    <section class="card stack">
      <div class="row">
        <span class="badge">viewer</span><span class="meta">{data.viewer}</span>
      </div>
      <form method="GET" class="row">
        <input name="owner" value={data.owner} placeholder="Circle owner's DID" style="flex:1;min-width:18rem" />
        <button class="secondary">Open circle</button>
      </form>
    </section>

    {#if data.owner === data.viewer && data.needsAuthorization}
      <section class="card stack">
        <h2>Create or reconnect your circle</h2>
        <p class="subtle">Your mutual followers can read and write. Records stay in each writer's permissioned PDS repo.</p>
        <div class="row">
          <form method="POST" action="?/create">
            <button>Create and connect</button>
          </form>
          <form method="POST" action="?/authorize">
            <input type="hidden" name="owner" value={data.owner} />
            <button class="secondary">Connect an existing circle</button>
          </form>
        </div>
      </section>
    {:else if data.needsAuthorization}
      <form method="POST" action="?/authorize" class="card stack">
        <input type="hidden" name="owner" value={data.owner} />
        <h2>Connect this circle</h2>
        <p class="subtle">The provider needs a one-time delegation before it can verify and index this Space.</p>
        {#if data.error}<div class="error">{data.error}</div>{/if}
        <button>Authorize private reads</button>
      </form>
    {:else}
      <form method="POST" action="?/post" class="card stack">
        <input type="hidden" name="owner" value={data.owner} />
        <input type="hidden" name="replyUri" value={replyUri} />
        <input type="hidden" name="replyCid" value={replyCid} />
        {#if replyUri}
          <div class="row">
            <span class="badge">replying to {replyUri.slice(-13)}</span>
            <button class="secondary" type="button" onclick={() => { replyUri = ""; replyCid = ""; }}>cancel</button>
          </div>
        {/if}
        <textarea name="text" maxlength="2000" required placeholder="Write something for your circle…"></textarea>
        <div class="row"><button>Post to permissioned repo</button></div>
      </form>

      <section aria-label="Circle notes">
        {#each data.notes as note (note.uri)}
          <article class="card stack">
            <div class="note">{note.value.text}</div>
            <div class="meta">{note.did} · {new Date(note.value.createdAt).toLocaleString()}</div>
            <div class="row">
              <form method="POST" action="?/react">
                <input type="hidden" name="owner" value={data.owner} />
                <input type="hidden" name="uri" value={note.uri} />
                <input type="hidden" name="cid" value={note.cid} />
                <button class="secondary">♥ {note.counts?.reaction ?? 0}</button>
              </form>
              <button class="secondary" type="button" onclick={() => { replyUri = note.uri; replyCid = note.cid; window.scrollTo({ top: 0, behavior: "smooth" }); }}>Reply</button>
              <span class="badge">{note.counts?.note ?? 0} replies</span>
            </div>
          </article>
        {:else}
          <div class="card subtle">No synchronized notes yet. New writes may take a few seconds to arrive through the provider queue.</div>
        {/each}
      </section>
    {/if}
  {/if}
</main>
