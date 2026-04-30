# Contrail patterns (for AI agents)

Companion to <https://flo-bit.dev/contrail/llms-full.txt> — that's the full reference. This file is the opinionated short version: how this template uses contrail in practice, so you don't have to derive it from docs every time.

## Reading data — almost always `listRecords`

The default pattern for *any* data fetch is:

```ts
const client = getServerClient(platform!.env.DB);          // server
// or: const client = getClient();                          // browser

const res = await client.get('<ns>.<short>.listRecords', {
  params: {
    limit: 50,
    sort: 'createdAt',
    order: 'desc',
    // ...filter params from contrail.config.ts `queryable` block
    // ...hydration flags (e.g. `profiles: true`)
  }
});

if (!res.ok) return { records: [] };
const records = res.data.records;  // typed against your lexicon
```

Where:
- `<ns>` is `config.namespace` from `src/lib/contrail.config.ts`.
- `<short>` is the key in `config.collections` (the short name, *not* the full NSID).

If the user gives a vague spec ("show me X"), the answer is almost always a `listRecords` call with a filter. Reach for `getRecord` only when you genuinely need one record by URI — listing with a filter that narrows to one is usually fine and keeps the codepath uniform.

## Filtering — declared in `contrail.config.ts`

Available filter params are declared per-collection in `queryable`. If a filter doesn't exist, add it there and re-run `pnpm generate:pull` — don't filter in JS after the fact.

```ts
// src/lib/contrail.config.ts
collections: {
  bookmark: {
    collection: 'app.mybookmarks.bookmark',
    queryable: {
      tag: {},                       // → ?tag=design
      createdAt: { type: 'range' }   // → ?createdAtMin=...&createdAtMax=...
    }
  }
}
```

### "Filter by author" is built-in — don't add it to `queryable`

`?actor=<did-or-handle>` (and its alias `?did=<did>`) is a built-in filter on every `listRecords` endpoint. It resolves the actor to a DID, triggers a one-shot PDS backfill for fresh data, and filters records to that author. **Do not** add `did: {}` or `actor: {}` to `queryable` — it's redundant and may fight the built-in handler.

```ts
// ✅ "this user's bookmarks" — works with no queryable changes
client.get('<ns>.bookmark.listRecords', { params: { actor: did } });
```

`queryable` is for *record-content* filters (fields inside the record JSON), not for author lookup.

There is **no `hydration` field** on a collection config — don't add one. Hydration is controlled by *query parameters at request time* (next section).

## Hydration — query-time, not config-time

To pull related data alongside records, pass it as a `params` flag on the `listRecords` call:

```ts
const res = await client.get('<ns>.<short>.listRecords', {
  params: { limit: 50, profiles: true }   // ← query param
});

res.data.records   // the records
res.data.profiles  // the hydrated author profiles, keyed by did
```

`profiles: true` joins each record's author profile (defaults to `app.bsky.actor.profile`) into `res.data.profiles`. Use this instead of fetching profiles in a loop.

If you need *additional* profile NSIDs beyond `app.bsky.actor.profile` (e.g. an app-specific profile type), declare them at the **top level** of `ContrailConfig`:

```ts
export const config: ContrailConfig = {
  namespace: 'app.example',
  profiles: ['app.bsky.actor.profile', 'app.example.actor.profile'],
  collections: { /* ... */ }
};
```

That's a config-time concern (which collections count as profiles); the `profiles: true` flag at query time is what triggers hydration on a given request.

## Where to call from

| Where | Use | Why |
|---|---|---|
| `+page.server.ts`, `+layout.server.ts`, `+server.ts` | `getServerClient(platform!.env.DB)` | In-process, zero HTTP, full types |
| `.svelte` (client-side, on user action) | `getClient()` from `$lib/contrail/client` | Hits `/xrpc/` over fetch — same typed surface |

### Two `getClient` exports — they're different

There are two `getClient`s in the codebase. They do different things:

| Import | Returns | Use when |
|---|---|---|
| `getClient()` from `$lib/contrail/client` | typed contrail client (calls local `/xrpc/`) | Any in-app data fetch from the browser. **Default to this.** |
| `getPDSClient({ did })` from `$lib/atproto/methods` | `Promise<Client>` for a specific user's PDS | Direct PDS calls (rare in app code — usually only the `methods.ts` helpers need this) |

If autocomplete gives you `Promise<Client>` and `.get` doesn't exist on the result, you imported the wrong one. Switch to `$lib/contrail/client`.

### "Get *this user's* records" → `actor` param, not the `did` arg of `getServerClient`

The `did` second argument to `getServerClient(db, did)` is **only** for acting as that user when reading permissioned data (spaces, communities). Public `listRecords` calls do *not* need it — and passing it does nothing useful for filtering.

To fetch records created by a specific user, pass `actor` as a **query param**:

```ts
// ✅ Correct — filter records to those whose author is this DID
const client = getServerClient(platform!.env.DB);
const res = await client.get('<ns>.<short>.listRecords', {
  params: { actor: did, limit: 1 }
});

// ❌ Wrong — `did` here means "auth as this user", not "filter by author"
const client = getServerClient(platform!.env.DB, did);
const res = await client.get('<ns>.<short>.listRecords', {
  params: { limit: 1 }
});
```

`actor` accepts a DID or a handle and is resolved to a DID server-side. `did` is also accepted as a synonym. Use `actor` for both "this is the user whose records I want" and "this is the actor of a feed read".
| Inside `routes/api/cron/+server.ts` | Don't call client APIs — use `contrail.ingest()` directly | That's the indexer, not a reader |

Default to server-side loading via `+page.server.ts` for initial page data. Use client-side only for live updates, infinite scroll, or post-action refetches.

## Writes — `putRecord`, `deleteRecord`, `uploadBlob`

Three helpers handle all writes. The actual SvelteKit remote functions live in `src/lib/atproto/server/repo.remote.ts`; client-friendly wrappers are in `src/lib/atproto/methods.ts`. From a `.svelte` file, always import from `methods`:

```ts
import { putRecord, deleteRecord, uploadBlob, createTID } from '$lib/atproto/methods';

await putRecord({
  collection: 'app.mybookmarks.bookmark',  // must be listed in settings.ts `collections`
  rkey: createTID(),
  record: { url, title, createdAt: new Date().toISOString() }
});
```

The collection must be in `src/lib/atproto/settings.ts` `collections` — that array drives both the OAuth scope (`scope.repo({ collection: [...] })`) *and* the runtime allowlist in `repo.remote.ts`. Adding a new writable collection means: lexicon → `contrail.config.ts` → `settings.ts` → `pnpm generate:pull`.

### Indexing happens automatically — don't call `contrail.notify` yourself

After every successful `putRecord`, the remote function calls `contrail.notify(uri, db)` so contrail re-indexes the record immediately. You do **not** need to do this in app code — and shouldn't. The next `listRecords` call will see the new record. (See `repo.remote.ts:38-44`.)

`deleteRecord` does *not* notify; deletions propagate via Jetstream within ~minute. If a record needs to disappear from the UI right away, filter it out optimistically and let the index catch up.

### Optimistic UI is still worth doing

Even with auto-notify, `putRecord` takes ~100–300ms round-trip. For interactive flows (post-as-you-type, emoji reactions, like buttons), render the local copy immediately and let the network call settle in the background — don't await before updating state.

Concrete pattern with rollback on failure:

```ts
import { SvelteSet } from 'svelte/reactivity';
import { putRecord, deleteRecord, createTID } from '$lib/atproto/methods';

let local = $state<Array<{ rkey: string; text: string; createdAt: string }>>([]);
let pending = new SvelteSet<string>();   // rkeys mid-flight

async function post(text: string) {
  const rkey = createTID();
  const createdAt = new Date().toISOString();
  // 1. Render immediately — UI updates this tick.
  local = [{ rkey, text, createdAt }, ...local];
  pending.add(rkey);

  try {
    // 2. Write in the background.
    await putRecord({
      collection: '<ns>.note',
      rkey,
      record: { text, createdAt }
    });
    pending.delete(rkey);
    // Auto-notify already re-indexed; the next listRecords will see it.
  } catch (e) {
    // 3. Roll back on failure.
    local = local.filter((r) => r.rkey !== rkey);
    pending.delete(rkey);
    throw e;
  }
}

// In the template, dedupe local + server records (see "List rendering" above)
// so the server copy doesn't re-render once it shows up via listRecords.
$: allRecords = Array.from(
  new Map(
    [...local, ...serverRecords].map((r) => [r.rkey ?? r.uri, r])
  ).values()
);
```

Key points: generate the `rkey` *client-side* (via `createTID()`) so the optimistic copy and the server copy share the same identity for dedup. Track in-flight rkeys in a `SvelteSet` if you want to disable retries / show a spinner. Roll back the local insert if the write throws.

### Blobs

`uploadBlob` handles the bytes-over-remote-function dance and auto-detects image dimensions for `aspectRatio`. Embed the returned blob in a record:

```ts
const uploaded = await uploadBlob({ blob: file });
await putRecord({
  collection: 'app.mybookmarks.thumbnail',
  rkey: createTID(),
  record: { image: uploaded, createdAt: new Date().toISOString() }
});
```

To enable blob uploads, add `scope.blob({ accept: ['image/*'] })` to `scopes` in `settings.ts` (and adjust `accept` for the mime types you allow). Without that scope, the OAuth flow won't grant blob-write permission and uploads 401.

## Following feeds — opt-in

If the app has a "follow other users → see their stuff in a feed" pattern, contrail's `feeds` config does the fan-out for you. **Skip this section if the app doesn't have a social graph** — public `listRecords` is the right primitive for most apps.

### Mental model

A feed is a (follow-collection, [target-collections]) pair, named by you. Every time someone the *actor* follows posts to a target collection, contrail inserts one row into `feed_items` for that actor. Reading a feed reads back through that table, joined with the standard pipeline (filters, hydration, profiles).

```
feed: timeline
  follow:  app.bsky.graph.follow      // contains { subject: did, createdAt }
  targets: [app.bsky.feed.post]
```

### Config

```ts
// src/lib/contrail.config.ts
export const config: ContrailConfig = {
  namespace: 'app.example',
  collections: {
    follow: { collection: 'app.bsky.graph.follow' },
    post:   { collection: 'app.bsky.feed.post', queryable: { /* ... */ } }
  },
  feeds: {
    timeline: {
      follow: 'follow',          // short name from collections, NOT the NSID
      targets: ['post'],
      maxItems: 500              // optional, default 200
    }
  }
};
```

Both the follow collection and every target collection must be declared in `collections`. Names in `feeds` are the *short names* (the keys of `collections`), not NSIDs. Config validation will throw if you reference an unknown short name.

### Follow-record shape requirement

The follow collection's record must have a `subject` field at the top level whose value is the followed DID. `app.bsky.graph.follow` matches this naturally (`{ subject: 'did:plc:...', createdAt }`). For a custom follow lexicon, keep the `subject` field — contrail extracts it via JSON path `$.subject` to determine "who is being followed."

### Read

```
GET /xrpc/<ns>.getFeed?feed=timeline&actor=<did-or-handle>&limit=50
```

Optional `&collection=<short>` to filter to one target (defaults to the first in `targets`). Filters and hydration from the target collection's `queryable` config also work — same params as `listRecords`.

The `actor` parameter is **whose feed** you're reading, not a filter on record creator. Feeds are always per-user; there's no anonymous feed read.

### How fan-out works

- **On a write to a target collection** (e.g. someone you follow posts): contrail inserts a `feed_items` row for every follower whose follow record has `subject = <author DID>`. One write → N inserts. There's no max-followers cap; if a celebrity has 1M followers and posts, that's 1M inserts.
- **On a write to the follow collection** (someone follows a new user): contrail backfills the most recent 100 target records from that user into the new follower's feed. The 100 is hardcoded — separate from the per-feed `maxItems` cap.
- **On first read for a (actor, feed) pair**: contrail backfills the actor's follow records from their PDS, then populates `feed_items` from existing target records. Marked complete in `feed_backfills` so it only happens once.
- **Pruning**: the cron run trims `feed_items` per actor down to `maxItems`, keeping newest by `time_us`.

### Gotchas

- The 100-record-per-new-follow backfill is hardcoded in `core/router/feed.ts` — not currently tunable per feed.
- No tests exist specifically for feeds yet; the write/read paths are live but treat the integration as load-bearing-but-untested in your sanity checks.
- Following many users with a viral target collection is expensive on writes (one row per follower). For an app expecting that scale, partition feeds or rate-limit writes upstream — contrail will not back off on its own.
- Feeds live in the main DB regardless of the spaces split — no `feeds_db` binding.

## Spaces and communities — opt-in, default to *not* using them

The template ships with public records only. **Don't enable spaces or communities unless the user's data model genuinely needs them** — they add config, secrets, and a parallel set of XRPC methods (`<ns>.space.*`, `<ns>.community.*`). For 80% of atproto apps (public posts, public lists, public anything), skip this whole section.

### When to reach for **spaces**

When records *can't* be public on a PDS — invite-only event guest lists, members-only forum threads, private group calendars. Records inside a space are gated by an ACL (the space's member list), not visible to the world.

The mental model: *a space is a bag of records with one lock; the member list says who has the key*. One owner, one record type per space, every member has read + write. No nested ACLs — richer permission models = more spaces.

To enable, add a `spaces` block to `contrail.config.ts`:

```ts
spaces: {
  type: 'app.example.event.space',     // NSID for the space record type
  serviceDid: 'did:web:example.com',   // DID for the worker — must be your deployed domain
}
```

Plus per-collection: `allowInSpaces: false` to keep a collection public-only.

`serviceDid` is the catch — `did:web:<your-domain>` requires serving a `/.well-known/did.json` at that domain. The user has to set this up; the AI can scaffold the JSON file but the domain has to be theirs. For dev, skip spaces entirely.

`listRecords` becomes auth-aware: anonymous → public only; authenticated with no `spaceUri` → public ∪ caller's spaces; with `?spaceUri=...` → that one space (ACL-checked). Records from spaces carry a `space: <spaceUri>` field in responses.

#### Default to a separate D1 for spaces data

When enabling spaces, provision a **second** D1 database for the spaces tables — keep the public-records DB and the permissioned-data DB isolated. Contrail supports this natively via a `spacesDb` parameter; defaults to the main DB if omitted, but don't omit it.

```sh
npx wrangler d1 create <project>-spaces
# → copy database_id into wrangler.jsonc
```

`wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB",         "database_name": "<project>",        "database_id": "..." },
  { "binding": "SPACES_DB",  "database_name": "<project>-spaces", "database_id": "..." }
]
```

Then thread it through `src/lib/contrail/index.ts`:

```ts
export async function ensureInit(db: D1Database, spacesDb: D1Database) {
  if (!initialized) {
    await contrail.init(db, spacesDb);
    initialized = true;
  }
}

export function getServerClient(db: D1Database, spacesDb: D1Database, did?: string): Client {
  return createServerClient(async (req) => {
    await ensureInit(db, spacesDb);
    return handle(req, db, spacesDb) as Promise<Response>;
  }, did);
}
```

Every call site (`+page.server.ts`, `+layout.server.ts`, `routes/api/cron/+server.ts`, `repo.remote.ts`) needs to pass `platform.env.SPACES_DB` alongside `platform.env.DB`.

Full reference: <https://flo-bit.dev/contrail/docs/spaces/llms.txt>.

### When to reach for **communities**

When records should be published under a *shared* identity — a team's calendar, a project's announcements, not "user X posted this". A community is a DID that multiple members can act *through*, with tiered access levels.

Two modes:
- **Minted** — contrail creates a fresh `did:plc` and holds its keys. Irreversible without the recovery rotation key (returned once at mint time).
- **Adopted** — contrail takes over an existing account via an app password. Reversible — the owner can revoke the app password anytime.

Communities sit *on top of* spaces — a community owns spaces, and member-access-levels decide who can act in which spaces.

Config:

```ts
community: {
  masterKey: env.COMMUNITY_MASTER_KEY,   // 32-byte encryption key (secret!)
  serviceDid: 'did:web:example.com',
  levels: ['admin', 'moderator'],        // your custom levels, ranked highest-first
}
```

`masterKey` envelope-encrypts stored credentials (app passwords for adopted communities, signing keys for minted). Set as a wrangler secret: `pnpm env:generate-secret | npx wrangler secret put COMMUNITY_MASTER_KEY`. Never check it in.

Full reference: <https://flo-bit.dev/contrail/docs/communities/llms.txt>.

### Decision flow

Quick decision tree before adding either:

1. Are all the records the app deals with OK to be world-readable on the user's PDS? → **No spaces, no communities. Stop.**
2. Some records are private but always belong to one user? → Still no spaces; just don't show them in your UI / use atproto's own scope system. Spaces are for *shared* private data.
3. Records belong to a *group* (multiple members can read/write)? → Spaces.
4. Records should be published under a *shared identity* (the group itself "posts" things, not individual users)? → Communities (which use spaces under the hood).

If the user describes their app in two sentences and never says "members", "invite-only", "private group", or "team-owned", you don't need this section.

## End-to-end types — trust them, debug from them

Everything is typed:

- `client.get('...')` autocompletes the method name from your registered lexicons.
- `params` is typed against the `queryable` block in `contrail.config.ts`.
- `res.data.records[i].value` is typed against the lexicon record schema (the `record` block of the NSID).

**If types feel wrong, the cause is almost always one of:**
1. The collection isn't in `contrail.config.ts` yet → add it, then `pnpm generate:pull`.
2. You changed `contrail.config.ts` but didn't regenerate → run `pnpm generate:pull`.
3. The lexicon JSON in `lexicons/custom/` doesn't match what you're calling → run lexicon.garden's `validate_lexicon` MCP tool against it.
4. You're typing `res.data.records[i]` directly without checking `res.ok` first → the `!res.ok` early-return narrows the type.

When something looks off, **read the generated types in `src/lexicon-types/`** — they're the ground truth for what the API actually returns. Don't guess from the lexicon JSON.

## List rendering — always dedupe before `{#each}`

Contrail's `listRecords` can return the same record twice during a tight indexing window (especially right after `notify`). With `{#each records as r (r.uri)}`, that throws `each_key_duplicate` at runtime. Dedupe before rendering:

```svelte
{#each Array.from(new Map(records.map((r) => [r.uri, r])).values()) as r (r.uri)}
  ...
{/each}
```

Same pattern for any union of sources (server data + optimistic local data + jetstream live updates) — collapse all of them through one `Map` keyed by `uri` before passing to `{#each}`. Cheaper than rendering, and saves you a runtime crash the first time the index races itself.

## Upsert pattern — look up before write

User clicks "subscribe" twice while the first request is in flight → two records created → duplicate sidebar entries → `each_key_duplicate`. The fix is to look up by a queryable field first, reuse the existing rkey:

```ts
const client = getClient();
const existing = await client.get('<ns>.subscription.listRecords', {
  params: { actor: user.did, feedUrl, limit: 1 }   // requires `did` + `feedUrl` queryable
});

if (existing.ok && existing.data.records.length > 0) {
  return; // already subscribed — no-op (or update the existing record)
}

await putRecord({
  collection: '<ns>.subscription',
  rkey: createTID(),
  record: { feedUrl, createdAt: new Date().toISOString() }
});
```

For things that are unique-per-user-per-target (subscriptions, follows, likes), this is the right shape. Add a queryable on the "uniqueness" field so the lookup is one query, not a scan.

## Profile data, specifically

Most apps want to show "who posted this" alongside records. Two paths:

1. **Hydrate via `profiles: true`** in `listRecords` — best for lists. Use `extractProfile()` from `$lib/contrail/client` to normalize the entries.
2. **Fetch separately** for one-off lookups. Don't loop fetches; if you need many, use `listRecords` with a filter on `did`.

Whatever you do, **don't fetch profiles from `app.bsky.actor.getProfile` over the network in a loop** — that's the failure mode this hydration setup exists to avoid.
