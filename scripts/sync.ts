/**
 * Sync: discover users from relays and backfill their records from PDS.
 * Calls the sync endpoint in a loop until done.
 *
 * Usage: npx tsx scripts/sync.ts [base_url] [admin_secret]
 */

import { config } from "../src/config";

async function main() {
  const base = process.argv[2] || "http://localhost:8787";
  const secret = process.argv[3];
  const ns = config.namespace;

  const headers: Record<string, string> = {};
  if (secret) {
    headers["Authorization"] = `Bearer ${secret}`;
  }

  console.log("=== Syncing (discover + backfill) ===");

  let staleCount = 0;
  let lastRemaining = -1;

  while (true) {
    const res = await fetch(`${base}/xrpc/${ns}.admin.sync`, { headers });
    const result = (await res.json()) as {
      discovered: number;
      backfilled: number;
      remaining: number;
      done: boolean;
    };

    console.log(
      `  Discovered ${result.discovered}, backfilled ${result.backfilled} records, ${result.remaining} remaining`
    );

    if (result.done) {
      console.log("  Sync complete.");
      break;
    }

    // Detect stuck state — no progress after several attempts
    if (result.remaining === lastRemaining && result.discovered === 0 && result.backfilled === 0) {
      staleCount++;
      if (staleCount >= 3) {
        console.log("  No progress after 3 attempts, stopping. Run again to retry.");
        break;
      }
    } else {
      staleCount = 0;
    }
    lastRemaining = result.remaining;
  }

  console.log("\n=== Done ===");
}

main();
