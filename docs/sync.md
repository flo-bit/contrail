# Sync

Client-side reactive store over contrail's `watchRecords` endpoints. Subscribes once, reconciles forever, ships with optimistic updates and an optional IndexedDB cache.

Lives in its own package:

```bash
pnpm add @atmo-dev/contrail-sync
```

## Basic use

```ts
import { createWatchStore } from "@atmo-dev/contrail-sync";

const store = createWatchStore({
  url: "/xrpc/com.example.message.watchRecords?roomUri=at://...",
  transport: "sse", // or "ws"
});

store.subscribe(({ records, status }) => { /* re-render */ });
store.start();
```

Framework-agnostic — wrap it in Svelte `$state`, React `useSyncExternalStore`, Vue `ref`, whatever.

## Transports

- **SSE** (default) — one HTTP request, simplest. Works everywhere.
- **WS** — a two-step handshake: HTTP GET returns a snapshot + watch-scoped ticket, then you upgrade to WS. On Cloudflare, the WS terminates on a Durable Object that hibernates idle connections. Same event stream either way.

## Authenticated watches

Pass `mintTicket` for any non-public endpoint. One-shot string for SSR-minted tickets, function for fresh tickets per reconnect:

```ts
mintTicket: async () => (await fetch("/api/ticket")).then((r) => r.text()),
```

Tickets are minted server-side via `com.example.realtime.ticket` (or any app-specific route).

## Optimistic updates

```ts
store.addOptimistic({ rkey, did, record: { text: "hi" } });
// later, on mutation failure:
store.markFailed(rkey, err);
// or explicit rollback:
store.removeOptimistic(rkey);
```

When a real record with the same `rkey` arrives via the stream, the optimistic entry is dropped automatically.

## IndexedDB cache

Instant first paint from last session's records:

```ts
import { createIndexedDBCache } from "@atmo-dev/contrail-sync/cache-idb";

createWatchStore({
  url,
  cache: createIndexedDBCache(),
  cacheMaxRecords: 200,
});
```

Cached records show immediately; the live snapshot reconciles when the connection opens.

## Server-side config

Enable `watchRecords` emission in your Contrail config:

```ts
realtime: {
  ticketSecret: ENV.REALTIME_TICKET_SECRET, // 32 bytes
  pubsub: new DurableObjectPubSub(env.PUBSUB), // or in-memory for dev
}
```

See [indexing.md](./indexing.md) for the full config surface.

## Lifecycle

```
idle → connecting → snapshot → live
                         ↓ (disconnect)
                    reconnecting → snapshot → live
                         ↓ (stop)
                       closed
```

Stale records stay visible across reconnects until the fresh snapshot arrives, at which point anything the server didn't re-send is evicted. Survives offline periods cleanly.
