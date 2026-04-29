# contrail-e2e — end-to-end tests against a local ATProto stack

End-to-end test suite for Contrail against a sealed local ATProto stack.
Nothing touches the public ATProto — writes go to a local PDS, the local
Jetstream reads that PDS's firehose, and each test stands up its own
in-process Contrail ingester + XRPC handler to consume it.

## What's inside

| Service | Port | Purpose |
|---------|------|---------|
| PDS | 4000 | Personal Data Server (user repos) |
| PLC | 2582 | DID registry |
| Jetstream | 6008 | Firehose relay in JSON |
| TAP | 2480 | Sync/backfill relay |
| PostgreSQL | 5433 | Shared by PLC + Contrail |
| Maildev | 1080 | PDS email verification catcher |

## Prerequisites

Clone `atproto-devnet` as a sibling of this contrail repo:

```
some-workspace/
├── contrail/            (this repo)
└── atproto-devnet/
```

```bash
git clone https://github.com/OpenMeet-Team/atproto-devnet.git /path/to/atproto-devnet
```

## Running the tests

```bash
# From the monorepo root (one-time build of @atmo-dev/contrail)
pnpm install && pnpm build

# Bring the devnet stack up (creates .env from .env.example on first run)
cd apps/contrail-e2e
pnpm stack:up

# Run the suite
pnpm test:e2e          # once
pnpm test:e2e:watch    # re-run on change
```

> **Note:** `up` and `down` are reserved by pnpm (aliases for `update`), so
> the stack scripts are prefixed `stack:` to disambiguate. The test scripts
> are named `test:e2e` so the monorepo-wide `pnpm test` skips them in CI
> (they need the live docker stack).

## Tests

See `tests/` for the current suite. Each test header explains its scope.
Tests spin up their own `runPersistent` in-process against an isolated
postgres schema, so they don't interfere with each other or with a
dogfooding ingester running in another terminal.

### Gap-probe pattern (`it.fails`)

Some tests use vitest's `it.fails(...)` to pin currently-known gaps in
contrail behavior — they pass *because* contrail doesn't yet enforce the
condition. The moment the condition is enforced, the test flips from
passing to failing, forcing whoever lands the fix to update the assertion
to the new correct behavior. Each `it.fails` block names the gap inline.

## Teardown

```bash
pnpm stack:down    # stops containers AND wipes volumes for a clean slate
```

## Namespace

These tests use `rsvp.atmo` as the Contrail namespace — same as
[atmo-events](https://github.com/flo-bit/atmo-events), so the fixtures are
compatible with that frontend. If you're running your own namespace, edit
`config.ts`.

## Why not use `apps/postgres/`?

`apps/postgres/` connects Contrail to the public Bluesky Jetstream — useful
for indexing real events, unusable for writing test fixtures. This suite
gives a sealed environment where the tests control every record.

## Overrides

Copy `.env.example` to `.env` and edit. All ports, database credentials, and
devnet hostnames are overridable.
