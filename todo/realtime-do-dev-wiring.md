# Fix DO wiring in Vite dev (currently papered over with a `dev` flag)

## Context

In `examples/sveltekit-group-chat/src/lib/contrail/index.ts` the realtime
PubSub is selected with:

```ts
const pubsub = dev ? new InMemoryPubSub() : new DurableObjectPubSub(env.REALTIME);
```

That `dev` check is standing in for "the `RealtimePubSubDO` class isn't
actually registered with miniflare right now." It happens to line up with
Vite dev today, but it's not really a dev-vs-prod concern — it's a
build-wiring concern.

### Why the DO isn't available in Vite dev

- `wrangler.jsonc` declares the DO binding `REALTIME` with
  `class_name: "RealtimePubSubDO"` and `main: ".svelte-kit/cloudflare/_worker.js"`.
- `@sveltejs/adapter-cloudflare@7.x` sets up miniflare via `platformProxy`
  automatically in dev, so `platform.env.REALTIME` is bound.
- But the class lives inside the built worker. It's re-exported into
  `_worker.js` by `scripts/append-scheduled.ts` *after* `pnpm build`.
- Vite dev doesn't run that post-build step, so the DO binding points at
  nothing and `stub.fetch(...)` crashes with `Internal Error`.

## Three fixes, smallest → largest

### 1. App-level probe (smallest)

In the example only. Add a helper that tries a cheap `stub.fetch(health)`
at bundle-build time and falls back to `InMemoryPubSub` if it throws.

```ts
async function pickPubSub(ns: DurableObjectNamespace | undefined): Promise<PubSub> {
  if (!ns) return new InMemoryPubSub();
  try {
    const stub = ns.get(ns.idFromName('__probe__'));
    const res = await stub.fetch('http://probe/__health', { signal: AbortSignal.timeout(250) });
    if (res.ok) return new DurableObjectPubSub(ns);
  } catch {}
  return new InMemoryPubSub();
}
```

- Pro: no library change, no build change.
- Con: async bundle construction (currently sync), every app using contrail
  has to reinvent this.

### 2. Library helper with probe (medium, recommended)

Ship the probe in `@atmo-dev/contrail` as something like:

```ts
export async function resolveRealtimePubSub(
  ns?: DurableObjectNamespace,
  fallback: () => PubSub = () => new InMemoryPubSub(),
): Promise<PubSub>
```

Every app using contrail gets the correct behavior for free. Still async
construction, but now that lives at the library boundary where it's
easier to swallow.

- Pro: reusable primitive, fixes the smell at the right layer.
- Con: contrail now has opinions about "is the DO actually usable"; async
  bundle setup ripples to every consumer (our current `getBundle` is sync).

### 3. Proper dev-prod parity (largest, most correct)

Actually register the DO class with miniflare in Vite dev so `env.REALTIME`
works identically to prod.

- Restructure the DO re-export so it lives at a stable source path (no
  post-build patching).
- Configure `adapter({ platformProxy: { ... } })` with miniflare options
  that point at that stable entry for DO hosting. Likely needs a
  dedicated DO worker script in miniflare's `workers` config.
- Adjust `scripts/append-scheduled.ts` so it no longer duplicates the
  re-export; it only keeps the `scheduled` handler append.
- Drop the `dev ? InMemory : DO` branch in the example entirely — always
  `new DurableObjectPubSub(env.REALTIME)`.

- Pro: dev === prod, no branching anywhere, also unblocks WS-in-dev
  (which today forces `transport: dev ? 'sse' : 'ws'` in
  `+page.svelte`).
- Con: touches build config, wrangler config, and adapter-cloudflare
  internals. Non-trivial to get right; worth its own session.

## Related cleanup (do in the same pass)

- Once the DO works in dev, drop `transport: dev ? 'sse' : 'ws'` at
  `src/routes/c/[communityDid]/[channelKey]/+page.svelte` — always `'ws'`.
- Remove the `dev` import from `src/lib/contrail/index.ts` and
  `+page.svelte` (only remaining consumer).
- Revisit whether `InMemoryPubSub` should stay exported at all from the
  example config; if option 3 lands, it's only needed for non-CF hosts.

## Recommendation

Go with **(2)** next. It's the right layer, and the async-construction
cost is modest (one-time probe at first use). Tackle (3) when we do the
broader "unify transport" pass.
