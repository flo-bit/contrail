# Contrail — PostgreSQL Example

A complete example of using Contrail to index AT Protocol calendar events and RSVPs with PostgreSQL. Includes persistent Jetstream ingestion (long-running listener) and user discovery/backfill.

## Setup

```bash
# Copy this folder to a new project
cp -r examples/postgres my-contrail-app
cd my-contrail-app

# Install dependencies
npm install
```

> **Note:** The `contrail` dependency in `package.json` points at `github:flo-bit/contrail`.
> If you're using a fork with PostgreSQL support that hasn't been merged yet, update the
> dependency to point at your fork's branch:
>
> ```bash
> npm install github:your-username/contrail#your-branch
> ```
>
> Or install from a local checkout:
>
> ```bash
> npm install /path/to/your/contrail
> ```

### Start PostgreSQL

**Option A: Docker (recommended)**

```bash
docker compose up -d
```

This starts PostgreSQL on port 5433 (to avoid conflicts with a local instance) with a `contrail` database ready to use. Override the port with `PG_PORT=5432 docker compose up -d`.

**Option B: Native PostgreSQL**

```bash
createdb contrail
```

Set `DATABASE_URL` to point at your local instance:

```bash
export DATABASE_URL="postgresql://user:password@localhost:5432/contrail"
```

## Configure

Edit `config.ts` to define your collections, queryable fields, relations, and references. See the [Contrail README](https://github.com/flo-bit/contrail) for all options.

## Run

### 1. Discover users and backfill records

```bash
npm run sync
```

This finds users from ATProto relays and backfills their existing records from PDS. Safe to interrupt and restart — progress is saved per-DID in the database.

### 2. Start persistent ingestion

```bash
npm run ingest
```

This opens a long-lived Jetstream connection and continuously indexes new records as they appear on the network. Events are batched and flushed every 5 seconds (or every 50 events, whichever comes first). Handles reconnection automatically.

Press `Ctrl+C` for graceful shutdown — the current batch is flushed and the cursor is saved so the next run picks up where it left off.

### 3. Serve the XRPC API

```bash
npm run serve
```

Your XRPC API is now available at `http://localhost:3000`:

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

## Running everything together

In production you'd typically run sync once (or periodically), then keep `ingest` and `serve` running as separate processes:

```bash
# Initial sync (run once, or periodically to discover new users)
npm run sync

# In separate terminals (or use a process manager)
npm run ingest
npm run serve
```
