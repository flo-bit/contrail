/**
 * Sync: discover users from relays and backfill their records from PDS.
 * Runs directly against D1 via wrangler bindings — no dev server needed.
 *
 * Usage:
 *   npx tsx scripts/sync.ts           # local D1
 *   npx tsx scripts/sync.ts --remote  # prod D1
 */

import { getPlatformProxy } from "wrangler";
import { config as rawConfig } from "../src/config";
import { resolveConfig, validateConfig, getCollectionNames } from "../src/core/types";
import { initSchema } from "../src/core/db";
import { discoverDIDs, backfillAll } from "../src/core/backfill";

const config = resolveConfig(rawConfig);
validateConfig(config);

function elapsed(start: number): string {
  const ms = Date.now() - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

async function main() {
  const remote = process.argv.includes("--remote");
  const syncStart = Date.now();

  console.log(`=== Sync (${remote ? "remote/prod" : "local"} D1) ===\n`);

  const { env, dispose } = await getPlatformProxy<{ DB: D1Database }>({
    environment: remote ? "production" : undefined,
  });
  const db = env.DB;

  try {
    await initSchema(db, config);

    // Phase 1: Discover all DIDs from relays
    console.log("--- Discovery ---");
    const discoveryStart = Date.now();
    const allDiscovered = new Set<string>();
    while (true) {
      const dids = await discoverDIDs(db, config, Infinity);
      if (dids.length === 0) break;
      for (const did of dids) allDiscovered.add(did);
      console.log(`  Found ${allDiscovered.size} unique users so far`);
    }
    console.log(`  Done: ${allDiscovered.size} users in ${elapsed(discoveryStart)}\n`);

    // Ensure dependent collections have backfill entries for all known DIDs
    const dependentCollections = getCollectionNames(config).filter(
      (col) => config.collections[col]?.discover === false
    );
    for (const depCol of dependentCollections) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO backfills (did, collection, completed)
           SELECT i.did, ?, 0 FROM identities i
           LEFT JOIN backfills b ON b.did = i.did AND b.collection = ?
           WHERE b.did IS NULL`
        )
        .bind(depCol, depCol)
        .run();
    }

    // Phase 2: Backfill all pending records
    console.log("--- Backfill ---");
    const backfillStart = Date.now();

    const pending = await db
      .prepare("SELECT COUNT(*) as count FROM backfills WHERE completed = 0")
      .first<{ count: number }>();
    const pendingCount = pending?.count ?? 0;

    const uniqueUsers = await db
      .prepare("SELECT COUNT(DISTINCT did) as count FROM backfills WHERE completed = 0")
      .first<{ count: number }>();

    const userCount = uniqueUsers?.count ?? 0;
    console.log(`  ${pendingCount} pending collection backfills for ${userCount} users`);

    const total = await backfillAll(db, config, {
      concurrency: 100,
      onProgress: ({ records, usersComplete, usersTotal, usersFailed }) => {
        const secs = (Date.now() - backfillStart) / 1000;
        const rate = secs > 0 ? Math.round(records / secs) : 0;
        const failStr = usersFailed > 0 ? ` | ${usersFailed} failed` : "";
        process.stdout.write(
          `\r  ${records} records | ${usersComplete}/${usersTotal} users | ${rate}/s | ${elapsed(backfillStart)}${failStr}   `
        );
      },
    });
    process.stdout.write("\n");

    console.log(`  Done: ${total} records in ${elapsed(backfillStart)}\n`);

    // Summary
    const finalRemaining = await db
      .prepare("SELECT COUNT(*) as count FROM backfills WHERE completed = 0")
      .first<{ count: number }>();
    const failed = await db
      .prepare("SELECT COUNT(*) as count FROM backfills WHERE completed = 1 AND retries > 0")
      .first<{ count: number }>();

    console.log(`=== Finished in ${elapsed(syncStart)} ===`);
    console.log(`  Discovered: ${allDiscovered.size} users`);
    console.log(`  Backfilled: ${total} records`);
    if ((finalRemaining?.count ?? 0) > 0)
      console.log(`  Remaining:  ${finalRemaining!.count} backfills`);
    if ((failed?.count ?? 0) > 0)
      console.log(`  Failed:     ${failed!.count} (exceeded retries)`);
  } finally {
    await dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
