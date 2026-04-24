# Cross-space watchRecords (actor-scoped live queries)

## Context

Today `<collection>.watchRecords` is per-space only — the endpoint rejects
requests without `spaceUri`:

```ts
// src/core/router/collection.ts:563-568
if (!spaceUri) {
  return c.json(
    { error: "InvalidRequest", message: "spaceUri required (cross-space watch is deferred)" },
    400
  );
}
```

This means the app's `createWatchQuery` helper only works for queries
scoped to one permissioned space. `listRecords` has no such restriction —
it already supports `?actor=<did>` for cross-space listings.

## The concrete gap in the group-chat example

The channel list spans multiple spaces: each channel lives in its own
space, authored by the community DID. Current flow:

- **SSR**: `+layout.server.ts` calls `<ns>.channel.listRecords` with
  `actor=<communityDid>`.
- **Live updates**: `connectCommunityRealtime` in `realtime.svelte.ts`
  opens an EventSource on `<ns>.realtime.subscribe?ticket=...` keyed to
  `community:<did>`, filters for `tools.atmo.chat.channel` events, and
  calls `invalidateAll()` to re-run the loader.

That works, but it means:
- Two realtime mechanisms in the app (watchRecords for messages, raw
  `realtime.subscribe` + `invalidateAll` for channels).
- Channel list is re-fetched from the server on every update rather than
  being incrementally maintained client-side.

## The fix

Allow `watchRecords` to be actor-scoped, mirroring `listRecords`:

- Remove the "spaceUri required" gate when `actor` is supplied.
- Snapshot: reuse the existing `runPipeline` path (already handles
  actor-filtered + permissioned-space union for the caller).
- Live topic: `actor:<did>` (contrail already exposes `actorTopic`)
  or `community:<did>` (via `communityTopic` when the actor is a
  registered community DID — the ticket endpoint already resolves this).
- Ticket minting: the `<ns>.realtime.ticket` endpoint already accepts
  `{ topic: "community:<did>" }` and returns a scoped ticket.

Once done, the app reads:

```ts
const channelsQuery = $derived(
  createWatchQuery({
    endpoint: 'tools.atmo.chat.channel',
    params: { actor: data.communityDid, limit: 100 }
  })
);
```

And `connectCommunityRealtime` + the `invalidateAll` dance goes away
(channel list is maintained incrementally; messages already use their
own per-space watch query).

## Open question to resolve before implementing

**ACL on the live stream.** `listRecords` filters per-space membership
on the query (via `runPipeline`'s `memberDid` path). For `watchRecords`
in this mode, events come from the pubsub via the `community:<did>` (or
`actor:<did>`) topic. **It needs to be verified** that the stream
actually filters events against the caller's per-space memberships —
otherwise a non-member could see `record.created` for a private channel
they're not in.

Audit targets:
- `src/core/realtime/publishing-adapter.ts` — what topics does it publish
  a space write to? If it publishes to `community:<did>` unconditionally,
  that event is delivered to every community-topic subscriber regardless
  of their per-space access.
- `src/core/realtime/router.ts` / `resolveTopicForCaller` — does the
  ticket issuer verify the caller's membership at ticket-mint time, or
  is `community:<did>` treated as a public-ish topic available to anyone
  who can name the community?
- `src/core/router/collection.ts:653-697` — the watchRecords WS path
  filters by `querySpec`; the SSE path has its own filtering. Either
  way, filtering happens server-side; make sure it evaluates
  per-space membership, not just collection/actor match.

If the existing filter story is insufficient, a small gate needs to be
added: each event that leaves the stream is checked against the
caller's membership of the event's `space`, and dropped if the caller
has no access.

## Scope estimate

- If ACL is already correct: ~1 hour. Small change to remove the
  spaceUri gate and wire actor → topic resolution.
- If ACL filter needs adding: ~half-day. Introduce a per-event
  membership check in the stream's filter path and cache memberships
  on the connection to keep it cheap.

## Out of scope for this work

- Combining multiple `actor` values (single-actor queries are enough
  for the community-channels use case).
- Hydration relations across the actor-scoped snapshot — same machinery
  as today; just confirm it works without `spaceUri` context.

## Cleanup after this ships

- Delete `connectCommunityRealtime` from the example's
  `lib/rooms/realtime.svelte.ts` (and its ticket fetching helper).
- `+layout.server.ts` stops fetching channels and pass them via page
  data; the layout uses `createWatchQuery` directly.
- Consider whether `channelMessages` (the per-space message store) is
  still needed — it's there for the prior SSR-message pattern; messages
  are now read directly from `messagesQuery.records`. Probably delete.
