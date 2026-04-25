# Communities as labelers

## Context

Layer 1 of the labels module ships in v0.4: contrail subscribes to external
labelers, indexes their labels, hydrates `record.labels` onto responses
(see `docs/08-labels.md`). The next interesting question is whether
contrail-managed *community* DIDs can themselves act as labelers.

This is a feature that doesn't really exist in atproto today: most labelers
are individual operator accounts. Group-controlled, role-gated labeling
where the labeler DID is shared by a moderation team — and from the outside
looks like any other atproto labeler — falls out almost for free from
combining the existing community module with the labels machinery.

## What a labeler needs

Three independent contracts in atproto-native fashion:

1. **Advertise** — `#atproto_labeler` service entry in the DID doc so
   clients can find the WS endpoint. Optionally, an
   `app.bsky.labeler.service` record with custom-value metadata
   (display name, blur policy, severity).
2. **Author** — a way to create signed labels with monotonic per-`src`
   `seq` numbers, retractable via `neg`.
3. **Serve** — `com.atproto.label.queryLabels` (paginated reads) and
   `com.atproto.label.subscribeLabels` (CBOR-framed WS firehose).

We have most of (2) already — the `labels` table is the storage. We'd
just be writing to it from a new XRPC instead of from the WS consumer.
(3) is layer 1 in reverse: same wire format, our side. (1) is the only
genuinely new thing, and even that mostly reuses existing community-signing
infrastructure.

## Mint vs adopt

- **Mint**: contrail holds a rotation key, so updating the DID doc to
  add `#atproto_labeler` is a routine signed PLC operation — same path
  the mint flow already uses. ✅ Supported in v1.
- **Adopt**: we hold an app password, not the rotation keys. We can
  write `app.bsky.labeler.service` to the existing PDS, but cannot
  update the DID doc to add the service entry. The owner has to do
  that manually (one-shot PLC operation, documented). 🟡 Documented
  manual step.

## The PDS gotcha (resolved)

Earlier sketch assumed we'd publish `app.bsky.labeler.service` to the
community's repo. But minted communities have no PDS — they're DIDs in
PLC with no repo. Spent a while exploring "contrail hosts a tiny repo
for minted communities" (option B) and concluded the simpler answer:
**most labelers don't need a service record**.

In atproto, you don't browse a directory of labelers — you find them
out-of-band and pass the DID to your client. The DID doc service entry
is what makes the labeler reachable; the service record is just metadata
for custom label values.

For standard atproto label values (`!hide`, `!warn`,
`!no-unauthenticated`, `porn`, `nudity`, `graphic-media`, `sexual`,
etc.) clients have hardcoded behavior. The service record only matters
for **custom** label values, where without it third-party clients
display the raw string with default styling.

So we tier the implementation:

| Tier | Mechanism | Custom values | Labeler-name in clients |
|---|---|---|---|
| 1 | DID doc service entry only | raw strings | "anonymous" |
| 2 | Tier 1 + hosted service-record endpoint | full metadata | yes |
| 3 | Tier 2 + general mini-PDS | n/a | (out of scope) |

**Tier 1 is shippable as v1.** Tier 2 is small and additive — one read
endpoint, one write XRPC, one new table — when someone actually wants
custom values. Tier 3 (general mini-PDS for minted communities) is a
separate architecture question that should ride or die on its own
merits, not on labels: it brings in the firehose-participation problem,
MST + commits, blob storage, and operator-as-durability-promise. Out
of scope.

## Sketch — Tier 1 surface

**Setup (admin / owner):**
```
community.becomeLabeler { communityDid }
  → updates DID doc (PLC op) to add service[id="#atproto_labeler",
    serviceEndpoint=<our service URL>]
community.unbecomeLabeler { communityDid }
  → reverse
```

**Authoring (configurable level — default `moderator`):**
```
community.label.create {
  communityDid,
  subject: { uri: "at://...", cid?: "..." } | { did: "did:plc:..." },
  val,
  exp?  // ISO-8601
}
community.label.negate { communityDid, subject, val }
community.label.list   { communityDid, cursor?, limit? }   // moderation UI
```

A `community.label.create` call:

1. Verifies caller's access level via the existing community ACL.
2. Optionally checks `val` against a per-community allowlist (Tier 2).
3. Builds the label object, signs with the community's signing key
   (existing `CredentialCipher` + signer).
4. Inserts into `labels` with `src = communityDid` and a freshly
   minted per-src `seq`.
5. Publishes to a `labels:<communityDid>` pubsub topic for live
   subscribers.

**Public, proxy-routed:**
```
com.atproto.label.queryLabels         ?uriPatterns=...&sources=did:plc:...
com.atproto.label.subscribeLabels     WS, ?cursor=N
```

Both read `Atproto-Proxy: <communityDid>#atproto_labeler` to know which
community-as-labeler the caller is asking about, then filter
`labels WHERE src = ?` and serve. Live mode subscribes to
`labels:<communityDid>` and emits CBOR frames — structurally the
inverse of layer 1's WS consumer, with the same frame protocol.

## Storage additions

```sql
ALTER TABLE labels ADD COLUMN seq INTEGER;
-- nullable: NULL for ingested-from-remote rows, allocated for our own
-- outbound labels. seq IS NOT NULL is the marker for "we wrote this."

CREATE TABLE labeler_outbound (
  src TEXT PRIMARY KEY,            -- community DID acting as labeler
  next_seq INTEGER NOT NULL DEFAULT 1
);
-- atomic increment per label publish; serves as the seq source for
-- subscribeLabels.
```

Skip ingesting our own outbound stream — one extra check in the WS
consumer (`if known-community-DID, skip subscription`).

## Suggested order

Each step is independently shippable:

1. **`labels.seq` column + `labeler_outbound` counter.** Schema-only;
   no behavioural change.
2. **`community.label.create / .negate / .list`.** Operator-internal
   use only — labels go into the table, hydration starts surfacing them
   on caller responses, but no external discovery yet. Useful by itself
   if the operator's own appview is the only consumer.
3. **`community.becomeLabeler`.** DID-doc update. Now external clients
   can discover.
4. **`com.atproto.label.queryLabels` (proxy-routed).** External read
   API. Most clients use this for one-shot lookups.
5. **`com.atproto.label.subscribeLabels` (WS).** External firehose.
   Reuses the realtime pubsub.
6. **Realtime topic + live emission.** Wires `labels:<communityDid>`
   events into `subscribeLabels` for live updates.

Roughly 1–2 days of work per step.

## Open questions

1. **Which access level can label?** Add a config field:
   `community.labelers: ["moderator", "admin", "owner"]` ranked.
   Default to `manager` upward.
2. **Per-community label-value allowlist?** Bluesky enforces "labelers
   can only emit values they declared in their service record." Without
   a service record (Tier 1), there's nothing to enforce against. When
   we layer Tier 2, plumb the allowlist check through.
3. **Permission set hook.** Auto-generated `<namespace>.permissionSet`
   should pick up `community.label.create` etc. so OAuth consent
   renders correctly. Should fall out of the existing permission-set
   generator since it already enumerates all XRPCs.

## What this gets you that's actually new

A moderation team gets actual access-level structure (junior moderators
can label `!warn` only, senior can label anything, owners can rotate
keys), and from the outside looks like a single labeler DID — Bluesky's
app, other appviews, third-party clients all consume it normally. That's
a reasonably interesting primitive that falls out almost for free from
layers 1 + community.
