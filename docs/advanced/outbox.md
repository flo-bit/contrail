# Outbox

> Experimental. Enable only on a fresh, empty database.

Transactionally records indexed puts/deletes alongside canonical writes so you can reliably feed external search indexes, webhooks, or caches. Destination failures never block ingestion.

## Configure

```ts
const config: ContrailConfig = {
  namespace: "com.example",
  collections: {
    event: { collection: "community.lexicon.calendar.event" },
  },
  changes: {
    consumers: {
      search: {
        collections: ["community.lexicon.calendar.event"], // full NSIDs
        phases: ["historical", "live"],                    // optional; default both
        initial: "history",                                // "history" | "future" | "current"
      },
    },
  },
};
```

| `initial` | Starts from |
| --- | --- |
| `history` | All retained historical and live changes |
| `future` | Changes written after consumer registration |
| `current` | Keyset snapshot + catch-up tail + atomic activation (requires `changeBootstraps` handlers) |

## Deliver

### Cloudflare Worker

```ts
export default createWorker<{ SEARCH_ENDPOINT: string }>(config, {
  deliveries: {
    search: async (batch, { env, signal }) => {
      const res = await fetch(env.SEARCH_ENDPOINT, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cursor: batch.cursor,
          upserts: batch.currentRecords,
          deletes: batch.absentUris,
        }),
      });
      if (!res.ok) throw new Error(`Search returned ${res.status}`);
    },
  },
});
```

`createWorker` runs delivery rounds after scheduled ingestion. Throwing retries with backoff; returning acknowledges the batch. Delivery is **at least once** — make handlers idempotent (upsert/delete by URI).

### Persistent Node.js

```ts
await Promise.all([
  contrail.runPersistent({ signal }),
  contrail.runPersistentDeliveries({
    env,
    deliveries: { search: deliverSearch },
    runtime: { signal },
  }),
]);
```

## Operate

```bash
pnpm contrail changes status --remote
pnpm contrail changes retry search --remote
pnpm contrail changes prune --remote
```

- Startup fails closed if a configured consumer is removed or incompatibly changed.
- Adding a consumer is only allowed if its collection/phase coverage was already retained; otherwise rebuild on a fresh database.
- `changes skip --through <pos> --reason "..." --yes` is an explicit audited data-loss escape hatch for stuck consumers.
