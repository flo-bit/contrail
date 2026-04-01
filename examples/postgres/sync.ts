/**
 * Discover users and backfill their records into PostgreSQL.
 *
 * Safe to kill at any point — discovery and backfill cursors are saved
 * per-DID in the database. Restarting resumes from where it left off.
 *
 * Usage:
 *   DATABASE_URL="postgresql://contrail:contrail@localhost:5432/contrail" npx tsx sync.ts
 */
import pg from "pg";
import { Contrail } from "@atmo-dev/contrail";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import { config } from "./config";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://contrail:contrail@localhost:5433/contrail";

function elapsed(start: number): string {
  const ms = Date.now() - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = createPostgresDatabase(pool);
  const contrail = new Contrail({ ...config, db });
  const syncStart = Date.now();

  console.log(`=== Sync (PostgreSQL) ===\n`);

  await contrail.init();

  console.log("--- Discovery ---");
  const discoveryStart = Date.now();
  const discovered = await contrail.discover();
  console.log(
    `  Done: ${discovered.length} users in ${elapsed(discoveryStart)}\n`,
  );

  console.log("--- Backfill ---");
  const backfillStart = Date.now();
  const total = await contrail.backfill({
    concurrency: 10,
    onProgress: ({ records, usersComplete, usersTotal, usersFailed }) => {
      const secs = (Date.now() - backfillStart) / 1000;
      const rate = secs > 0 ? Math.round(records / secs) : 0;
      const failStr = usersFailed > 0 ? ` | ${usersFailed} failed` : "";
      process.stdout.write(
        `\r  ${records} records | ${usersComplete}/${usersTotal} users | ${rate}/s | ${elapsed(backfillStart)}${failStr}   `,
      );
    },
  });
  process.stdout.write("\n");
  console.log(`  Done: ${total} records in ${elapsed(backfillStart)}\n`);

  console.log(`=== Finished in ${elapsed(syncStart)} ===`);
  console.log(`  Discovered: ${discovered.length} users`);
  console.log(`  Backfilled: ${total} records`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
