# Auth

Contrail has four auth mechanisms. Which one applies depends on who's calling and what they're asking for.

| Mechanism | Used by | For |
|---|---|---|
| Anonymous | anyone | public reads |
| Service-auth JWT | third-party apps acting on behalf of a user | anything permissioned (spaces, communities) |
| In-process server client | your own server code | loaders / actions that skip HTTP entirely |
| Invite token | anonymous bearers | read-only access to a specific space |
| Watch ticket | browsers | realtime subscriptions (`watchRecords`) |

## Service-auth JWTs

The standard atproto mechanism. When a third-party app wants to call your contrail service as a user, it:

1. Asks the user's PDS to mint a service-auth JWT with `com.atproto.server.getServiceAuth` — the token's claims include `iss` (user's DID), `aud` (your service DID), `lxm` (the specific method NSID), and a short expiry.
2. Sends the request to your service with `Authorization: Bearer <jwt>` and `Atproto-Proxy: <did>#<service-id>` so the PDS knows where to route.

Contrail verifies every request against the public key in the issuer's DID doc (`@atcute/xrpc-server` does the heavy lifting). It checks:

- Signature valid
- `aud` matches the `serviceDid` you configured
- `lxm` covers the method being called
- Token hasn't expired

On pass, your handler sees a populated `serviceAuth = { issuer, audience, lxm, clientId }` context and can proceed. On fail, 401 or 403 with a structured reason.

### The `serviceDid` gotcha

Use the **plain DID** (no `#fragment`) when configuring contrail:

```ts
spaces: { serviceDid: "did:web:example.com" }  // right
spaces: { serviceDid: "did:web:example.com#com_example_space" }  // wrong
```

Many PDS implementations reject `aud` values containing `#fragment` in `com.atproto.server.getServiceAuth`, and contrail does strict string equality on `aud`. The fragment form belongs only in your DID doc's `service` entry, where PDSes use it to resolve the service endpoint URL for `Atproto-Proxy` routing — that's separate from JWT audience validation.

## In-process server client

When your own server code wants to call contrail, the service-auth dance is pointless — it's your code talking to your code. `createServerClient` skips it:

```ts
import { createServerClient } from "@atmo-dev/contrail/server";

const client = createServerClient(async (req) => handle(req, env.DB), userDid);

// Calls bypass fetch entirely; acts as `userDid` for ACL purposes.
const res = await client.get("com.example.event.listRecords", { params: {...} });
```

Pass `did` to act as that user; omit it for anonymous calls against public endpoints. This is a trust boundary — anything that actually crosses a network needs a real service-auth JWT, not this shortcut.

See [SvelteKit + Cloudflare](./frameworks/sveltekit-cloudflare.md) for the typical loader pattern.

## Invite tokens

First-class auth for spaces. When a space owner creates an invite:

```
com.example.space.invite.create  { spaceUri, ttl?, maxUses? }
  → { token: "...plaintext..." }  // returned once, never again
```

The plaintext token is handed to the user out-of-band (link, QR, email). Contrail stores only a SHA-256 hash. Redemption is one atomic UPDATE: `used_count++ WHERE hash = ? AND !revoked AND !expired AND !exhausted`.

Three invite kinds, depending on what the token does:

- **`join`** — redeemed via `com.example.space.invite.redeem` with a service-auth JWT. Adds the caller's DID to the member list. Members have full read + write inside the space; there's no per-member permission axis beyond "is a member."
- **`read`** — bearer-only. The token itself grants read access when passed as `?inviteToken=<plaintext>`, no DID, no redemption. Good for sharing a read-only link that doesn't add anyone to the member list.
- **`read-join`** — both. Works anonymously as a read token; can also be redeemed with a JWT to promote the caller to member.

Tokens can be revoked (`invite.revoke`), expire automatically (`ttl`), and be exhausted (`maxUses`).

## Watch tickets

Realtime subscriptions (`watchRecords`) can't use regular service-auth JWTs for two reasons: the WebSocket upgrade can't carry arbitrary headers, and an open socket would outlive a 60s JWT TTL. So contrail uses separate short-lived tickets.

Server-side minting comes in two flavours:

- `com.example.realtime.ticket` — POST `{ topic }` (e.g. `"space:ats://..."`) → `{ ticket, topics, expiresAt }`. Bare topic-list ticket, used with the generic `<ns>.realtime.subscribe` endpoint.
- `<collection>.watchRecords?mode=ws&spaceUri=…` (or `&actor=…`) handshake — returns `{ snapshot, ticket, wsUrl, sinceTs, ticketTtlMs, querySpec }`. The ticket is bound to `(did, topics, querySpec)` and is the one to use for the per-collection `watchRecords` stream — both for SSE (`?ticket=…`) and the subsequent WS upgrade.

Both flavours are signed by `realtime.ticketSecret` (a 32-byte random, configured once). Clients hand the ticket off via `?ticket=...` on connect.

In the `@atmo-dev/contrail-sync` client:

```ts
createWatchStore({
  url: "/xrpc/com.example.message.watchRecords?spaceUri=ats://...",
  mintTicket: async () => (await fetch("/api/ticket")).then((r) => r.text()),
});
```

Each reconnect mints a fresh ticket, so expiry doesn't matter for long-lived subscriptions. See [Sync](./07-sync.md) for the full flow.

## OAuth permission sets

When a user grants a third-party app permission to act as them in your contrail service, the consent screen is driven by a **permission set** — a lexicon that bundles every XRPC method you expose. Contrail auto-generates `{namespace}.permissionSet` for you; `contrail-lex` publishes it alongside the other lexicons.

A third-party app requests scope by referencing your permission set's NSID in its OAuth metadata:

```jsonc
"scope": "include:com.example.permissionSet"
```

The user's PDS fetches that lexicon (via DNS-backed NSID resolution), shows the user what methods are being requested, and mints scoped service-auth JWTs on confirmation.

### DNS requirements

Permission sets live under *your* namespace (`com.example.permissionSet`), so PDSes resolve the NSID via DNS. Resolution does **not** walk up subdomains — every authority in your NSID tree needs its own `TXT` record at `_lexicon.<reversed-domain-path>`.

`contrail-lex publish` prints the exact records you need (also works as a `--dry-run`). Without them, permission sets can't be fetched, and users get errors instead of a consent screen.

## Anonymous / public

No auth needed for:

- `listRecords` / `getRecord` without `spaceUri` — returns public records
- `getProfile`, `getCursor`, `getOverview`
- `notifyOfUpdate` (unless you set `notify: "some-bearer-token"` in config; then it needs `Authorization: Bearer <that>`)

Public requests skip all verification middleware — no JWT parsing, no DID-doc fetch. Fast path.

## How the pieces fit

A typical flow for a third-party app acting as a user in a space:

1. App registers OAuth client pointing at your permission set NSID.
2. User grants consent — PDS fetches your permission set lexicon via DNS, shows the user the methods, records the scope.
3. App calls `com.atproto.server.getServiceAuth` on the user's PDS: `{ aud: "did:web:example.com", lxm: "com.example.space.putRecord", exp: <60s> }`. PDS signs, returns JWT.
4. App sends `PUT /xrpc/com.example.space.putRecord` with `Authorization: Bearer <jwt>` and `Atproto-Proxy: did:web:example.com#com_example_space`.
5. User's PDS reads the `Atproto-Proxy` header, resolves the service endpoint from your DID doc, forwards the request.
6. Contrail verifies the JWT (signature, `aud`, `lxm`, expiry), runs ACL check (is this DID a member of that space?), dispatches the write.

For your own loaders/actions, steps 3–6 collapse into a single `createServerClient({did}).post(...)` call. For a browser subscribing to a feed, steps 3–5 are replaced by a ticket mint from your server. Same auth model, different surface.
