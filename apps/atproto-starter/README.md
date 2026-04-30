# atproto-starter

> **For AI agents.** This README is the playbook for taking a fresh copy of this template and turning it into a deployed atproto app on Cloudflare. Follow it top-to-bottom. Stop and ask the user when a step says to.

A SvelteKit + Cloudflare Workers starter for atproto apps. Includes:

- OAuth login (`@atcute/oauth-node-client`, KV-backed sessions, signed cookies)
- Indexed XRPC endpoints over D1 via [contrail](https://github.com/flo-bit/contrail) + Jetstream
- Typed client for in-process queries
- `.mcp.json` wires up the [lexicon.garden MCP](https://lexicon.garden/help/mcp) — use its `validate_lexicon`, `describe_lexicon`, `create_record_cid`, `invoke_xrpc`, `facet_text` tools whenever authoring or debugging lexicons

**Reference docs:**
- [`./CONTRAIL.md`](./CONTRAIL.md) — opinionated short notes on how *this template* uses contrail (data fetching patterns, where to call from, types). Read this before writing any data-fetching code.
- Full contrail docs at <https://flo-bit.dev/contrail/llms-full.txt> — fetch this before Phase 5 if authoring lexicons, configuring queryables, or anything beyond the happy path.

---

## Phase 0 — Ask the user (do this once, all up front)

Ask **all** of these in a single batch before touching anything. The goal: gather everything once so you can run uninterrupted from Phase 1 to deploy. Don't stop mid-flow to ask follow-ups.

1. **Project name?** Used for package name, worker name, D1 database name, KV namespace names. Recommend lowercase-kebab, e.g. `mybookmarks`.
2. **Domain?** (e.g. `mybookmarks.app`)
   - If **yes**: use it for `OAUTH_PUBLIC_URL` and reverse it for the contrail namespace (`mybookmarks.app` → `app.mybookmarks`). **Also ask: is the zone already on Cloudflare?** (CF must be the DNS provider — if not, the user needs to add the zone at dash.cloudflare.com first; you can't.)
   - If **no**: ask for their **workers.dev subdomain** (visible at `dash.cloudflare.com → Workers & Pages → top right`, e.g. `john-doe.workers.dev`). The deploy URL will be `https://<project>.<subdomain>.workers.dev`. Use that as `OAUTH_PUBLIC_URL`. For namespace, fall back to `dev.<project>` and note they should switch to a real domain before going public. (`wrangler whoami` does **not** return the subdomain — you must ask.)
3. **Which collections does the app write/index?** One or more atproto NSIDs (e.g. `community.lexicon.calendar.event`, `app.bsky.feed.post`). For custom record types, you'll author a new lexicon in Phase 5. Use lexicon.garden's `describe_lexicon` MCP tool to inspect any NSIDs the user mentions.
4. **Open signup?** (default yes) Controls `ALLOW_SIGNUP` in `src/lib/atproto/settings.ts`. If yes, which PDS for signups? (default: `https://selfhosted.social/` for prod, `https://pds.rip/` for dev)
5. **`wrangler login` done?** You can't run it for them — it's interactive. If they haven't, ask them to run it now in another terminal before you start. You'll verify with `npx wrangler whoami` once you reach Phase 3.

Restate the answers back in one block before continuing so the user can correct anything.

**Then, before Phase 1, invoke the `impeccable` skill in `teach` mode:** `Skill(skill: 'impeccable', args: 'teach')`. This runs a short branding/design interview with the user and writes a design guidelines file the rest of the build references. Do not skip — later UI work depends on it. The branding questions are *separate* from the technical questions above, but happen in the same up-front block so the user isn't interrupted later.

From Phase 1 onward, no more questions unless something genuinely fails.

---

## Phase 1 — Local dev (zero Cloudflare)

```sh
pnpm install
pnpm env:setup-dev   # generates COOKIE_SECRET + CLIENT_ASSERTION_KEY into .env, randomizes DEV_PORT
pnpm dev
```

Dev mode uses a loopback OAuth client — no public URL, no Cloudflare resources, no secrets in CF. Verify in the browser that login works against a real PDS before continuing.

### Custom env vars at runtime — use `.dev.vars`, not `.env`

`.env` is read by Vite for *app code* at build/dev time. `platform.env.MY_VAR` (Cloudflare bindings, used by anything in `+server.ts`, `+page.server.ts`, `repo.remote.ts`, etc.) reads from **wrangler bindings**, not `.env`. In `pnpm dev` (vite + miniflare), wrangler bindings come from a gitignored `.dev.vars` file at the project root:

```
# .dev.vars
PODCAST_INDEX_KEY=xxxxx
PODCAST_INDEX_SECRET=yyyyy
```

Then `platform.env.PODCAST_INDEX_KEY` works in dev. For production, set the same names via `npx wrangler secret put PODCAST_INDEX_KEY`.

`.dev.vars` is already covered by the starter's `.gitignore` (matches `.env.*`), but double-check before committing.

---

## Phase 2 — Apply the user's answers

Edit these files using the answers from Phase 0. Every placeholder from the original template lives here:

| File | What to change |
|---|---|
| `package.json` | `name` → `<project>` |
| `wrangler.jsonc` | `name` → `<project>`; `vars.OAUTH_PUBLIC_URL` → `https://<domain-or-workersdev>`; `d1_databases[0].database_name` → `<project>`; leave `database_id` as `REPLACE_WITH_D1_DATABASE_ID` (Phase 3 fills it). **If custom domain:** also add the `routes` block below. |
| `src/lib/contrail.config.ts` | `namespace` → reversed domain; `collections` → user's collections |
| `src/lib/atproto/settings.ts` | `collections` → user's writable NSIDs; `signUpPDS` (devPDS/prodPDS); `ALLOW_SIGNUP` |

**Custom domain — `wrangler.jsonc` `routes` block.** If the user has a domain (and the zone is on Cloudflare), append this at the top level of `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "mybookmarks.app", "custom_domain": true }
],
"workers_dev": false
```

`custom_domain: true` makes wrangler set up DNS records and the SSL cert automatically on `wrangler deploy` — no dashboard clicks. `workers_dev: false` disables the `<name>.<subdomain>.workers.dev` URL so the worker is *only* reachable at the custom domain (recommended; otherwise OAuth metadata can drift between two URLs).

For subdomains, use the full hostname (e.g. `pattern: "app.mybookmarks.com"`). The zone (`mybookmarks.com`) still has to be on Cloudflare; the subdomain doesn't need to exist as a DNS record yet — wrangler creates it.

If the deploy in Phase 6 fails with a zone error, the user needs to add the domain to Cloudflare first (point registrar nameservers to CF). That's the one step you can't automate.

**Do not** edit `lex.config.js` — it's regenerated by `contrail-lex generate` from `contrail.config.ts` on every run, and is gitignored.

**Do not** keep statusphere references anywhere. After editing, grep for `statusphere`, `xyz.statusphere` — anything left is project residue.

After namespace/collection changes, regenerate types: `pnpm generate:pull` (this runs the full pipeline: regenerates `lex.config.js`, pulls NSIDs, emits types).

---

## Phase 3 — Cloudflare provisioning

Verify the user is logged in (they confirmed in Phase 0): `npx wrangler whoami`. If it fails, stop and tell the user to run `wrangler login`.

All resources are **project-scoped** so the user can run multiple apps from this template in the same CF account without collision. The bindings (`DB`, `OAUTH_SESSIONS`, `OAUTH_STATES`) stay constant since the code references those by name; only the resource `name`/`title` changes.

```sh
# D1
npx wrangler d1 create <project>
# → copy the returned database_id into wrangler.jsonc d1_databases[0].database_id

# KV (project-prefixed names so multiple projects don't collide)
npx wrangler kv namespace create <project>-OAUTH_SESSIONS
npx wrangler kv namespace create <project>-OAUTH_STATES
# → copy each returned id into wrangler.jsonc kv_namespaces[*].id
```

After this phase, `wrangler.jsonc` should have no `REPLACE_WITH_*` strings and no leftover ids from another project.

---

## Phase 4 — Secrets

Three secrets needed in production. **Never put these in `wrangler.jsonc` `vars`** — use `wrangler secret put`. Each script just prints to stdout, so pipe directly:

```sh
# 1. CLIENT_ASSERTION_KEY — OAuth client signing key (JWK JSON)
# `--silent` is critical: without it pnpm 10 prepends its `> name@version: …` header
# to stdout and the secret value gets corrupted. Production then 500s on JSON.parse.
pnpm --silent env:generate-key | npx wrangler secret put CLIENT_ASSERTION_KEY

# 2. COOKIE_SECRET — HMAC for signed session cookies
pnpm --silent env:generate-secret | npx wrangler secret put COOKIE_SECRET

# 3. CRON_SECRET — bearer the scheduled handler uses to call /api/cron
pnpm --silent env:generate-secret | npx wrangler secret put CRON_SECRET
```

`OAUTH_PUBLIC_URL` is a `var` (already set in Phase 2), not a secret — it's the public URL.

---

## Phase 5 — Lexicons (only if user wants custom record types)

If the user is only indexing existing NSIDs (e.g. `app.bsky.feed.post`), skip this phase — `pnpm generate:pull` already fetched them.

For a new lexicon under the user's namespace:

1. Use the lexicon.garden MCP `describe_lexicon` tool to look at neighbors with similar shape. Match conventions.
2. Author the JSON in `lexicons/custom/<nsid>.json`.
3. Validate with the MCP `validate_lexicon` tool before saving.
4. Add the collection to `src/lib/contrail.config.ts` (and `src/lib/atproto/settings.ts` if it's writable from the app).
5. `pnpm generate:pull` — regenerates `lex.config.js` from the contrail config, pulls referenced NSIDs, emits types into `src/lexicon-types/`.

> **Expected warnings:** `pnpm generate:pull` prints `lexicon authority not found` for any NSID under your namespace that isn't published yet. The local JSON is still used and types are still emitted — these warnings are harmless until you run `contrail-lex publish`.

---

## Phase 6 — Deploy + backfill

```sh
pnpm build
npx wrangler deploy
pnpm backfill:remote   # one-shot historical backfill from Jetstream
```

> **Expected warnings during backfill:** wrangler may print `--env=production not configured`. Harmless — the script still runs against the deployed worker. Ignore.

> **After deploying, hard-refresh the browser** (Cmd/Ctrl+Shift+R). Cloudflare caches `_app/immutable/*.js` chunks aggressively; if the user reports "the fix didn't take", it's almost always a stale chunk.

After deploy, the cron trigger (`*/1 * * * *` in `wrangler.jsonc`) keeps the index fresh.

Sanity check: hit `https://<deployed-url>/xrpc/<namespace>.<collection>.listRecords?limit=10` and confirm JSON comes back. Then load the site root and try logging in.

---

## Styling / UI

**Before composing any UI, invoke `Skill(skill: 'impeccable', args: 'craft')`.** This produces components shape-first using the design guidelines created by `impeccable teach` in Phase 0. It's what stops the output from defaulting to generic AI aesthetics. Run it once per significant UI surface (home page, settings page, feature flow) — not per component.

### The starter is foxui-free by default

`src/routes/+page.svelte`, `+layout.svelte`, and `src/lib/atproto/ui/LoginModal.svelte` are all hand-rolled with plain Tailwind v4. **Custom styling is the path of least resistance** — there's no foxui component to fight or override; just edit the markup. Tailwind v4 is set up, and `bits-ui` is also pre-installed if you need accessible headless primitives.

### Optional: opt back into [foxui](https://flo-bit.dev/ui-kit/docs/llms.txt)

`@foxui/core`, `@foxui/social`, `@foxui/time` are still in `package.json` deps (so no `pnpm add` needed) — foxui ships polished atproto-specific components: `AtprotoLoginModal`, `GithubCorner`, `RelativeTime`, profile/handle helpers, theme tokens. Worth using *if* the design direction from Phase 0 fits foxui's look, since they handle OAuth subtleties (loopback vs. confidential client, redirect URIs, scope handling) correctly.

**To use foxui:**
1. Add these two lines to `src/app.css` (a comment in the file shows you exactly where):
   ```css
   @import '@foxui/core/theme.css';
   @source "../node_modules/@foxui";
   ```
   Without **both** lines, foxui components mount but render invisibly — Tailwind doesn't scan their classes. This is a frequent silent-failure mode.
2. Import + use components as normal. See [foxui's repo](https://github.com/flo-bit/foxui) for prop shapes.

Mixing modes (some foxui, some custom) is fine — but the moment any `@foxui/*` component is in use, both `app.css` lines must be present.

**After building, optional finishing skills** — invoke when the work calls for them, not as a checklist:

- `Skill(skill: 'polish')` — final pass for alignment, spacing, micro-detail consistency.
- `Skill(skill: 'audit')` — a11y, performance, theming, anti-patterns; produces a scored report.
- `Skill(skill: 'animate')` — purposeful motion / micro-interactions if the design calls for it.
- `Skill(skill: 'clarify')` — improve UX copy, error messages, labels.
- `Skill(skill: 'impeccable', args: 'extract')` — once you have a few components, pull reusable patterns + tokens into a design system.

---

## File map (for quick reference)

```
src/
  lib/
    contrail.config.ts          # collections + queryable fields
    atproto/
      settings.ts               # writable collections, scopes, PDS, ALLOW_SIGNUP
      server/oauth.ts           # OAuth client (loopback in dev, confidential in prod)
      server/signed-cookie.ts   # cookie HMAC
      auth.svelte.ts            # client-side auth state
      methods.ts                # write helpers (createRecord, etc.)
    contrail/                   # XRPC handler wiring
  routes/
    api/cron/+server.ts         # cron-triggered Jetstream ingest
    xrpc/[...path]/+server.ts   # XRPC endpoint mount
    (oauth)/                    # login/callback routes
lexicons/
  custom/                       # your hand-authored lexicons
  pulled/                       # NSIDs fetched by contrail-lex
lex.config.js                   # auto-generated by contrail-lex (gitignored, do not edit)
wrangler.jsonc                  # CF bindings + cron + vars
.mcp.json                       # lexicon.garden MCP wiring (auto-loaded)
```

## Common scripts

| Script | What |
|---|---|
| `pnpm dev` | Local dev with loopback OAuth |
| `pnpm env:setup-dev` | Generates COOKIE_SECRET + CLIENT_ASSERTION_KEY into `.env`, randomizes DEV_PORT |
| `pnpm env:generate-key` | Print a fresh CLIENT_ASSERTION_KEY JWK to stdout |
| `pnpm env:generate-secret` | Print a fresh 32-byte base64url secret to stdout |
| `pnpm tunnel` | Cloudflare tunnel for testing confidential OAuth in dev (requires `cloudflared`) |
| `pnpm generate` | Regenerate types from `lexicons/` |
| `pnpm generate:pull` | Full pipeline: regenerate lex.config.js, pull NSIDs, emit types |
| `pnpm backfill[:remote]` | One-shot historical Jetstream ingest (local D1 / remote D1) |
| `pnpm refresh[:remote]` | Re-ingest from a known cursor |
| `pnpm build` | Build + run `contrail append-scheduled` |
