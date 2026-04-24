# Examples

Every example lives in [`apps/`](https://github.com/flo-bit/contrail/tree/main/apps) and pins contrail as `workspace:*`. Clone the repo, `pnpm install`, and each one runs.

## `rsvp-atmo` — the reference deployment

[`apps/rsvp-atmo`](https://github.com/flo-bit/contrail/tree/main/apps/rsvp-atmo)

Cloudflare Workers + D1. Indexes `community.lexicon.calendar.event` and `rsvp`. Exposes the full spaces + community + realtime surface. Cron-driven Jetstream ingestion every minute.

Use this if you're building on Workers and want a starting point that already has deploy config wired up.

```bash
pnpm --filter rsvp-atmo dev      # local wrangler + auto-cron
pnpm --filter rsvp-atmo deploy   # requires D1 database created
pnpm --filter rsvp-atmo sync     # discover + backfill against D1
```

## `group-chat` — full app showcase

[`apps/group-chat`](https://github.com/flo-bit/contrail/tree/main/apps/group-chat)

SvelteKit + Cloudflare Workers. The one that exercises everything: permissioned spaces for private rooms, community-controlled DIDs for groups, client-side `contrail-sync` for reactive messages, Durable Object-hibernated WebSockets for realtime delivery, OAuth-based login.

This is the canonical "what can contrail do" demo. If you're trying to understand how the pieces fit together end to end, read this app's code before anything else.

```bash
pnpm --filter sveltekit-group-chat dev
```

## `postgres` — Node + PG minimal

[`apps/postgres`](https://github.com/flo-bit/contrail/tree/main/apps/postgres)

The smallest possible Node deployment. Docker Compose for Postgres, three scripts: `sync` (discover + backfill), `ingest` (persistent Jetstream), `serve` (HTTP handler). Skips spaces/communities/realtime.

Use this as a template if you're running on a normal server and don't need Cloudflare's bells.

```bash
cd apps/postgres
docker compose up -d
pnpm sync
pnpm serve
```

## `cloudflare-workers` — minimal Workers

[`apps/cloudflare-workers`](https://github.com/flo-bit/contrail/tree/main/apps/cloudflare-workers)

The simplest working Worker. One collection (events), one HTTP handler, cron-driven ingest. No spaces, no communities. Good for reading top-to-bottom in one sitting to see what contrail does at minimum.

## `sveltekit-cloudflare-workers` — SvelteKit Statusphere

[`apps/sveltekit-cloudflare-workers`](https://github.com/flo-bit/contrail/tree/main/apps/sveltekit-cloudflare-workers)

A Statusphere-style SvelteKit app with OAuth login, contrail-indexed public records, and Cloudflare adapter. No spaces/communities — think "atproto blog or status post UI." Useful as a scaffold for public-only apps.

## Choosing a starting point

| Need | Start from |
|---|---|
| "Just index some records" | `cloudflare-workers` or `postgres` |
| "Index + SvelteKit UI, public only" | `sveltekit-cloudflare-workers` |
| "Private rooms / group chat / full stack" | `group-chat` |
| "Calendar-ish domain, Workers deploy" | `rsvp-atmo` |
