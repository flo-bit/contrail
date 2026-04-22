# sveltekit-group-chat

A Discord-like demo built on top of [contrail](https://github.com/flo-bit/contrail) — SvelteKit + Cloudflare Workers + D1, OAuth, spaces, communities, and realtime (SSE).

## What this exercises

- **`community`** — mint a fresh `did:plc` per server, tiered access levels (member / manager / admin / owner), space → space delegation.
- **`spaces`** — permissioned per-channel record tables, membership pushed in by the community reconciler.
- **`realtime`** — single SSE connection subscribed to `community:<did>`, fanning out per-channel events with unread dots derived client-side.
- Three record collections — `tools.atmo.chat.server`, `tools.atmo.chat.channel`, `tools.atmo.chat.message` — with unified `listRecords` for "every server / channel I can see" in one call.

## Setup

```sh
pnpm install
cp .env.example .env
# fill in COMMUNITY_MASTER_KEY and REALTIME_TICKET_SECRET with
#   openssl rand -base64 32
pnpm generate:pull    # emits lexicons + src/lib/atproto/generated-methods.ts
pnpm dev
```

Re-run `pnpm generate` whenever you add/remove collections or toggle contrail
modules in `src/lib/contrail/config.ts`: the OAuth scope list is derived from
it, so the consent screen only asks for permissions you actually use.

Dev mode uses a loopback OAuth client — no Cloudflare setup needed. The realtime Durable Object runs locally via miniflare.

### Auth in dev vs prod

Contrail normally auths every write with an atproto **service-auth JWT**. The browser delegates minting those JWTs to the SvelteKit worker, which calls `com.atproto.server.getServiceAuth` on the user's PDS.

bsky.social **refuses** that call for loopback OAuth clients, so out of the box a plain `pnpm dev` couldn't talk to contrail without a [cloudflared tunnel](#with-a-tunnel).

To skip the tunnel this example ships a **dev auth bypass** gated on `DEV_AUTH=1` in `.env`:

- Contrail's auth middleware trusts the HMAC-signed `did` session cookie the OAuth flow already sets, and uses its DID as the authenticated caller.
- The cookie is HMAC-signed with `COOKIE_SECRET`, so only this worker can mint a valid one.
- All access-level checks (admin+, manager+, etc.) still apply — the bypass only replaces the JWT step.

**Never set `DEV_AUTH=1` in production** — that would make the cookie the sole auth signal for third-party clients.

### With a tunnel

If you want to exercise the real JWT path in dev, run a tunnel and drop `DEV_AUTH`:

```sh
pnpm tunnel            # prints https://xxx.trycloudflare.com
# in .env: set OAUTH_PUBLIC_URL to the tunnel URL and remove DEV_AUTH
pnpm dev
# open the tunnel URL (not localhost)
```

## How the pieces connect

```
┌────────────┐   service-auth JWT   ┌─────────────────┐   contrail XRPCs   ┌───────────┐
│  browser   │ ─────────────────► │ SvelteKit worker │ ─────────────────► │ contrail  │
└────────────┘                      └─────────────────┘                    └───────────┘
     │                                       │                                   │
     │ EventSource /xrpc/.../realtime.subscribe?ticket=... ◄──────── realtime DO │
     └───────────────────────────────────────────────────────────────────────────┘
```

- The browser can't mint service-auth JWTs itself — it delegates to the SvelteKit worker, which uses the user's OAuth session to call `com.atproto.server.getServiceAuth` on their PDS. The resulting JWT is scoped to one `lxm`.
- Realtime tickets are minted the same way, then the browser holds an `EventSource` open against the subscribe endpoint.

## Data model

| Record | Lives in | Author |
|---|---|---|
| `tools.atmo.chat.server` | community's `members` space, rkey `self` | community DID (via `community.space.putRecord`) |
| `tools.atmo.chat.channel` | channel's own space, rkey `self` | community DID |
| `tools.atmo.chat.message` | channel's own space, rkey = TID | user DID |

Only admins (`admin+` in the target space) can write the server and channel records, and the community DID is the author. Reads filter by `actor=<communityDid>` so spoof records from random members are silently ignored.

## Feature map

| Route | What it does |
|---|---|
| `/` | "My servers" — unified `server.listRecords` over every space I'm in |
| `/new` | Mint community, bootstrap `members` role-space, write server record, show recovery key once |
| `/c/[communityDid]` | Redirects to the first channel you can see |
| `/c/[communityDid]/[channelKey]` | Chat view — messages via `space.listRecords` + realtime |
| `/c/[communityDid]/settings/members` | Add, promote, demote, revoke members |

## Private channels

New-channel modal offers a visibility toggle:

- **Public** — grants the `members` role-space `member` access on the new channel. Reconciler fans out to everyone.
- **Private** — grants each picked DID directly. Also grants `members` (so they can see the server header) but not automatic access to other channels.

## Deploy

```sh
npx wrangler d1 create group-chat
# add the database_id to wrangler.jsonc
npx wrangler secret put COMMUNITY_MASTER_KEY
npx wrangler secret put REALTIME_TICKET_SECRET

pnpm build
npx wrangler deploy
```

## Known gaps

This is a demo. It deliberately skips:

- **`adopt` mode** — only `mint` is wired up.
- **`$publishers`** / community-authored public posts.
- Threads, reactions, image uploads, rich text, typing indicators.

## License

MIT
