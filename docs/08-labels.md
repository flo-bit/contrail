# Labels

Atproto-native moderation hydration. Subscribe to one or more labelers, index their labels, and attach them to records and profiles in your XRPC responses. Opt-in; zero cost if you don't enable it.

## Mental model

> A **label** is a `(src, uri, val)` triple authored by a labeler DID. A **labeler** is a regular atproto account that publishes signed annotations about other accounts and records via `com.atproto.label.subscribeLabels`.

- One contrail deployment can subscribe to many labelers.
- The caller of your XRPC picks which subset to honor per request via the `atproto-accept-labelers` header (or `?labelers=` query param when headers are awkward — SSE/WS).
- Labels hydrate onto every `listRecords`, `getRecord`, `getProfile`, and `?profiles=true` response without changing your collection config.
- This module only consumes labels. Producing them — your appview emitting its own labels — is a separate question. See *Future work* below.

## Enable

```ts
import type { ContrailConfig } from "@atmo-dev/contrail";

const config: ContrailConfig = {
  namespace: "com.example",
  collections: { /* ... */ },
  labels: {
    sources: [
      { did: "did:plc:ar7c4by46qjdydhdevvrndac" }, // bsky moderation
      { did: "did:plc:newsmast" },
    ],
  },
};
```

`initSchema` creates a `labels` table and a `labeler_cursors` table. Both live on the main DB; nothing per-collection.

## Caller selection

Per request, contrail picks accepted labelers in this order:

1. `atproto-accept-labelers: did:plc:a, did:plc:b` — the spec's HTTP header.
2. `?labelers=did:plc:a,did:plc:b` — fallback for transports that can't set headers easily.
3. `config.labels.defaults` — operator policy.
4. Every entry in `config.labels.sources`.

The list is intersected with what's actually configured (unknowns dropped — only labelers we've subscribed to have rows to hydrate from) and capped at `maxPerRequest` (default 20). Contrail echoes the applied set back via `atproto-content-labelers`.

```
GET /xrpc/com.example.event.listRecords
  atproto-accept-labelers: did:plc:ar7c4by46qjdydhdevvrndac
```

→

```jsonc
// Response: atproto-content-labelers: did:plc:ar7c4by46qjdydhdevvrndac
{
  "records": [
    {
      "uri": "at://did:plc:.../com.example.event/...",
      "value": { /* ... */ },
      "labels": [
        {
          "src": "did:plc:ar7c4by46qjdydhdevvrndac",
          "uri": "at://did:plc:.../com.example.event/...",
          "val": "spam",
          "cts": "2026-04-25T00:00:00.000Z"
        }
      ]
    }
  ]
}
```

`labels` matches `com.atproto.label.defs#label` field-for-field — pass it straight to atproto SDK moderation helpers.

### `defaults: []`

Set defaults to an empty array if you want strict opt-in: callers that send no header / param see no labels at all.

## Hydration semantics

For each `(src, uri, val)` tuple visible to the caller, hydration picks the row with the highest `cts`. If that row has `neg=true`, the label is treated as retracted and dropped. Expired rows (`exp` past `now`) are filtered at the SQL level. CID-pinned labels apply only when the indexed record's CID matches.

Account-level labels (subject = bare DID) hydrate onto profiles. They appear inside each `ProfileEntry.labels` of the `profiles` array on `?profiles=true` responses, and on `getProfile`.

## Ingestion

`com.atproto.label.subscribeLabels` is a per-labeler WebSocket firehose with a CBOR frame envelope. Contrail mirrors its existing Jetstream pipeline:

| Mode | Function | When |
|---|---|---|
| Cron-driven | `contrail.ingestLabels()` | Cloudflare Workers — one drain per cron tick |
| Persistent | `contrail.runPersistentLabels()` | Node / long-lived servers — one socket per labeler, auto-reconnect |
| One-shot backfill | `pnpm contrail labels-backfill [--remote]` | Local script, drains until each labeler reports caught up |

When `config.labels` is set, the bundled `createWorker` already calls `ingestLabels()` from `scheduled()` alongside `ingest()` — no boilerplate.

```ts
// node / long-lived
const ac = new AbortController();
await Promise.all([
  contrail.runPersistent({ signal: ac.signal }),
  contrail.runPersistentLabels({ signal: ac.signal }),
]);
```

Per-labeler cursors live in `labeler_cursors` (`{did, cursor, endpoint, resolved_at}`). Endpoints are resolved from the DID doc's `service[id="#atproto_labeler"]` and cached for 6h. On `#info { name: "OutdatedCursor" }` frames, contrail resets the cursor to `0` so the next cycle re-backfills.

### `backfill: false`

Per source. Default: backfill from `cursor=0` on first sight. Set `false` to start at "now" — useful for very chatty labelers where you don't need history.

```ts
labels: {
  sources: [{ did: "did:plc:somenoisylabeler", backfill: false }],
}
```

## Storage

```sql
CREATE TABLE labels (
  src TEXT NOT NULL,        -- labeler DID
  uri TEXT NOT NULL,        -- subject: at://... or did:...
  val TEXT NOT NULL,        -- label value
  cid TEXT,                 -- optional record-version pin
  neg INTEGER NOT NULL DEFAULT 0,
  exp INTEGER,              -- expiry, unix sec
  cts INTEGER NOT NULL,     -- creation time, unix sec
  sig BLOB,                 -- signature bytes (stored, not verified in v1)
  PRIMARY KEY (src, uri, val, cts)
);
```

The PK includes `cts`, so a `neg=true` retraction is a *new row* that replaces the previous decision via the read-time collapse rule above — never an in-place mutation. This matches the spec, tolerates out-of-order delivery, and survives a labeler that flip-flops.

## What's not here

- **Signature verification.** `sig` is stored if the labeler supplies it, but contrail does not verify it in v1. Document as TODO; most appviews skip it.
- **Live label updates on `watchRecords`.** The realtime stream snapshots labels with the initial query but does not push label deltas. Adding this means publishing `labels:<src>` topic events from the ingest worker and merging them in `runQueryStream` — future work.
- **Spaces / community labels.** Hydration already runs on the spaces read paths, so labels emitted by a labeler-DID member of a space (or under a community DID) will show up if you write them to the `labels` table. The auth surface for "make this DID a labeler in this space" is not yet exposed as XRPCs.
- **Outbound `subscribeLabels`.** Contrail does not republish labels. Communities-as-labelers (using the community DID as `src`) is a natural extension once you want to act as a labeler instead of just consume.
- **Label definitions / preferences UX.** Custom label names, blur behaviors, severity, and per-user preference state belong on the *client*, fetched directly from each labeler. Contrail intentionally stays out of this.

## Design

Follows the [atproto label spec](https://atproto.com/specs/label) literally. The wire format on responses matches `com.atproto.label.defs#label` so existing atproto SDKs can consume it directly. Storage is the data model normalized into rows; ingestion mirrors Jetstream both in code shape and in operator UX.
