# @atmo-dev/contrail-sync

Client-side reactive watch-store over [contrail](https://www.npmjs.com/package/@atmo-dev/contrail)'s `watchRecords` endpoints.

- SSE (default) or WebSocket transports. WS handshake produces a watch-scoped ticket so Cloudflare Durable Objects can hibernate idle connections.
- Optimistic updates (`addOptimistic` / `markFailed` / `removeOptimistic`).
- Automatic reconciliation across reconnects: stale records stay visible until a fresh snapshot arrives, then entries the server didn't re-send are evicted.
- Optional persistent cache (IndexedDB adapter included) for instant first paint.

```ts
import { createWatchStore } from "@atmo-dev/contrail-sync";
import { createIndexedDBCache } from "@atmo-dev/contrail-sync/cache-idb";

const store = createWatchStore({
  url: "/xrpc/com.example.message.watchRecords?roomUri=at://...",
  transport: "ws",
  mintTicket: async () => (await fetch("/api/ticket")).then((r) => r.text()),
  cache: createIndexedDBCache(),
});

store.subscribe(({ records, status }) => {
  // re-render
});

store.start();
```

Framework-agnostic: wrap the subscribable store in your framework's reactive primitives (Svelte `$state`, React `useSyncExternalStore`, Vue `ref`, etc).
