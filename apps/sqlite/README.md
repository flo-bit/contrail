# sqlite

Minimal local Contrail app using Node's built-in SQLite adapter and one public collection (`community.lexicon.calendar.event`). Its package-local `contrail` wrapper supplies `data/contrail.sqlite` to the standard CLI, so backfill commands do not need storage boilerplate.

## One-command development service

From this directory:

```bash
pnpm dev
```

This creates or resumes `data/contrail.sqlite`, resolves any missing source Lexicons, bootstraps it from Alluvium, catches up from Jetstream in bounded 15-second cycles, and serves the complete public Contrail API and Lexicon bundle at `http://127.0.0.1:8787`. Try `/status` or `/.well-known/contrail`; stop it with Ctrl-C.

The package script opts into Alluvium and its currently reported partial calendar coverage. A project containing only `contrail.config.ts` can instead run plain `contrail dev`; without a Wrangler config it uses `.contrail/dev.sqlite` and PDS backfill by default. Add `--alluvium --allow-partial` when that config's discoverable collections are available from Alluvium.

## Alluvium bootstrap only

From this directory:

```bash
pnpm contrail backfill \
  --alluvium \
  --alluvium-epoch jetstream-us-east-alluvium-v1 \
  --allow-partial
```

The current public calendar manifest reports known historical omissions, hence the explicit `--allow-partial`. The command loads and verifies only the Alluvium base plus archive tail, then stores the archive boundary as the normal live cursor.

Inspect the result:

```bash
pnpm status
```

Run one 15-second bounded live-ingestion window from that cursor without starting the development server:

```bash
pnpm ingest
```

Repeat `pnpm ingest` to continue catch-up. This uses the same ingestion cycle as scheduled Workers, without Cloudflare's scheduler.

## PDS backfill

Without `--alluvium`, the unchanged default is selective PDS acquisition:

```bash
pnpm contrail backfill
```

All commands are resumable. To start a genuinely fresh generation, delete the SQLite database and its WAL files:

```bash
rm -f data/contrail.sqlite*
```

Do not delete those files merely to retry an interrupted run; rerun the same command with the same epoch instead.
