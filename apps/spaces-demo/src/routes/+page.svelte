<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { onMount } from "svelte";

  let { data, form } = $props();
  let loginHandle = $state("");
  let loggingIn = $state(false);
  let loginError = $state("");
  let replyUri = $state("");
  let replyCid = $state("");
  let refreshInFlight = false;
  let liveConnected = $state(false);
  let subscriptionOwner = $derived(
    data.signedIn && !data.needsAuthorization ? data.owner : null,
  );

  async function refreshProjection() {
    if (document.hidden || !data.signedIn || data.needsAuthorization || refreshInFlight) return;
    refreshInFlight = true;
    try {
      await invalidateAll();
    } finally {
      refreshInFlight = false;
    }
  }

  $effect(() => {
    const owner = subscriptionOwner;
    if (!owner) {
      liveConnected = false;
      return;
    }
    let disposed = false;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let retryDelay = 1_000;

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    };

    const connect = async () => {
      try {
        const response = await fetch("/api/space-subscription", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner }),
        });
        const body = await response.json() as { url?: string };
        if (!response.ok || !body.url) throw new Error("Live updates unavailable");
        if (disposed) return;
        socket = new WebSocket(body.url);
        socket.onopen = () => {
          liveConnected = true;
          retryDelay = 1_000;
        };
        socket.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          try {
            const message = JSON.parse(event.data) as { type?: string };
            if (message.type === "invalidate") void refreshProjection();
          } catch {
            // Ignore protocol keepalives or unknown messages.
          }
        };
        socket.onclose = () => {
          liveConnected = false;
          scheduleReconnect();
        };
        socket.onerror = () => socket?.close();
      } catch {
        liveConnected = false;
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      disposed = true;
      liveConnected = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  });

  onMount(() => {
    // Slow reconciliation is a safety net for dropped notifications, sleep,
    // and deployments rather than the primary update mechanism.
    const interval = window.setInterval(() => void refreshProjection(), 30_000);
    const onVisibility = () => {
      if (!document.hidden) void refreshProjection();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

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
        {#if !data.needsAuthorization}
          <span
            class="badge"
            title={liveConnected
              ? "Subscribed to verified Space projection updates"
              : "Reconnecting; periodic refresh remains active"}
          >{liveConnected ? "live" : "reconnecting"}</span>
        {/if}
      </div>
      <form method="GET" class="row">
        <input name="owner" value={data.owner} placeholder="Circle owner's DID" style="flex:1;min-width:18rem" />
        <button class="secondary">Open circle</button>
      </form>
      {#if data.circles.length}
        <div class="stack">
          <div class="row">
            <h2>Connected circles</h2>
            {#if data.circlesTruncated}<span class="badge">first 200</span>{/if}
          </div>
          {#each data.circles as circle (circle.uri)}
            <div class="row">
              <a href={`/?owner=${encodeURIComponent(circle.authorityDid)}`}>
                {circle.authorityDid === data.viewer ? "Your circle" : circle.authorityDid}
              </a>
              {#if circle.authorityDid === data.owner}<span class="badge">open</span>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    {#if data.owner === data.viewer && data.needsAuthorization}
      <section class="card stack">
        <h2>Create or reconnect your circle</h2>
        <p class="subtle">You control who can read and write through an owner-managed member list. Records stay in each writer's permissioned PDS repo.</p>
        <div class="row">
          <form method="POST" action="?/create" use:enhance>
            <button>Create and connect</button>
          </form>
          <form method="POST" action="?/authorize" use:enhance>
            <input type="hidden" name="owner" value={data.owner} />
            <button class="secondary">Connect an existing circle</button>
          </form>
        </div>
      </section>
    {:else if data.needsAuthorization}
      <form method="POST" action="?/authorize" class="card stack" use:enhance>
        <input type="hidden" name="owner" value={data.owner} />
        <h2>Connect this circle</h2>
        <p class="subtle">Ask the circle owner to add your handle to the PDS-native member list. The PDS must authorize your delegation before the provider will serve this circle.</p>
        {#if data.error}<div class="error">{data.error}</div>{/if}
        <button>Authorize private reads</button>
      </form>
    {:else}
      {#if data.owner === data.viewer}
        <section class="card stack" aria-label="Circle members">
          <div class="row">
            <h2>Native PDS members</h2>
            <span class="badge">{data.members.length + 1}</span>
          </div>
          <div class="row">
            <span class="badge">owner</span>
            <span class="meta">{data.owner}</span>
          </div>
          {#each data.members as member (member.did)}
            <div class="row">
              <span class="meta">{member.handle ? `@${member.handle}` : member.did}</span>
              {#if member.handle}<span class="subtle">{member.did}</span>{/if}
              <form method="POST" action="?/removeMember" use:enhance>
                <input type="hidden" name="owner" value={data.owner} />
                <input type="hidden" name="memberDid" value={member.did} />
                <button class="secondary">Remove</button>
              </form>
            </div>
          {/each}
          <form method="POST" action="?/addMember" class="row" use:enhance>
            <input type="hidden" name="owner" value={data.owner} />
            <input
              name="member"
              required
              placeholder="handle.example.com or did:plc:…"
              aria-label="New member handle or DID"
              style="flex:1;min-width:18rem"
            />
            <button>Add member</button>
          </form>
        </section>
      {/if}

      <form method="POST" action="?/post" class="card stack" use:enhance>
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
              <form method="POST" action="?/react" use:enhance>
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
