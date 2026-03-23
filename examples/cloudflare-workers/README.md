# Contrail — Cloudflare Workers Example

A complete example of using Contrail to index AT Protocol calendar events and RSVPs on Cloudflare Workers + D1.

## Setup

```bash
# Copy this folder to a new project
cp -r examples/cloudflare-workers my-contrail-app
cd my-contrail-app

# Install dependencies
npm install

# Create a D1 database
npx wrangler d1 create contrail
```

Copy the `database_id` from the output into `wrangler.jsonc`.

> **Note:** The `contrail` dependency installs from GitHub. This may take a minute on first install since it also pulls in the AT Protocol client libraries.

## Configure

Edit `config.ts` to define your collections, queryable fields, relations, and references. See the [Contrail README](https://github.com/flo-bit/contrail) for all options.

## Develop

```bash
# Discover users from relays and backfill their records
npm run sync

# Start the dev server (ingests from Jetstream every minute)
npm run dev
```

Your XRPC API is now available at `http://localhost:8787`:

```
# List events sorted by RSVP count
/xrpc/community.lexicon.calendar.event.listRecords?sort=rsvpsCount

# Upcoming events with 10+ going RSVPs
/xrpc/community.lexicon.calendar.event.listRecords?startsAtMin=2026-03-16&rsvpsGoingCountMin=10

# Single event with hydrated RSVPs and profiles
/xrpc/community.lexicon.calendar.event.getRecord?uri=at://...&hydrateRsvps=10&profiles=true

# Search events
/xrpc/community.lexicon.calendar.event.listRecords?search=meetup

# RSVPs for a specific event
/xrpc/community.lexicon.calendar.rsvp.listRecords?subjectUri=at://...
```

## Deploy

```bash
npm run deploy

# Sync against production D1
npm run sync:remote
```

Ingestion runs automatically via cron (`*/1 * * * *`).
