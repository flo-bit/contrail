# Outbox

> Experimental. Enable the outbox only on a fresh, empty Contrail database.

The outbox delivers indexed record changes to external projections such as search indexes, webhooks, or caches. Contrail appends each change in the same database transaction as the canonical record and source cursor; destination failures never roll back ingestion.

## Configure a consumer

```ts
const config: ContrailConfig = {
  namespace: "com.example",
  collections: {
    event: { collection: "community.lexicon.calendar.event" },
  },
  changes: {
    consumers: {
      search: {
        collections: ["community.lexicon.calendar.event"],
        phases: ["historical", "live"],
        initial: "history",
      },
    },
  },
};
```

Collections are full NSIDs, not config short names. Omitting `phases` includes both historical backfill and live ingestion.

## Deliver from a Worker

Add one handler for every configured consumer:

```ts
type Env = { SEARCH_ENDPOINT: string };

export default createWorker<Env>(config, {
  deliveries: {
    search: async (batch, { env, signal }) => {
      const response = await fetch(env.SEARCH_ENDPOINT, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cursor: batch.cursor,
          upserts: batch.currentRecords,
          deletes: batch.absentUris,
        }),
      });
      if (!response.ok) throw new Error(`Search returned ${response.status}`);
    },
  },
});
```

`createWorker` runs bounded delivery rounds after scheduled ingestion. Throwing retries the batch with backoff; returning successfully acknowledges it.

Delivery is **at least once**. A destination may apply a batch before the acknowledgement fails, so handlers must be idempotent. Upsert and delete by record URI rather than incrementing counters.

Claims coalesce repeated changes to the same URI. `currentRecords` contains the latest indexed values when the batch is delivered; `absentUris` contains records that are currently deleted.

## Initial state

| `initial` | Starts with |
|---|---|
| `history` | All retained historical and live changes |
| `future` | Changes written after the consumer is registered |
| `current` | A current-state snapshot, a fixed catch-up tail, then atomic destination activation |

`current` is intended for building a candidate index without a read gap. It additionally requires matching `changeBootstraps` snapshot and activation handlers.

For a long-lived Node process, run delivery beside ingestion:

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

Status reports each consumer's position, backlog, lease, and retry state. Pruning never passes the slowest durable consumer. `changes skip` is an explicit audited data-loss operation and should be reserved for recovery.

Once enabled, ordinary startup fails closed if a consumer is removed or changed incompatibly. Adding a consumer is safe only when its collection/phase coverage was already retained; otherwise build a fresh database generation.
