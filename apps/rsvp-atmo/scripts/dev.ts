/**
 * Start wrangler dev and auto-trigger the cron every 60s.
 *
 * Usage: npx tsx scripts/dev.ts
 */

import { spawn } from "child_process";

async function main() {
  const wrangler = spawn("npx", ["wrangler", "dev", "--test-scheduled"], {
    stdio: "inherit",
    shell: true,
  });

  // Wait for wrangler to start
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("Auto-ingestion started (every 60s)");

  const interval = setInterval(async () => {
    try {
      await fetch("http://localhost:8787/__scheduled?cron=*/1+*+*+*+*");
    } catch {
      // wrangler not ready yet or shutting down
    }
  }, 60_000);

  // Trigger once immediately
  try {
    await fetch("http://localhost:8787/__scheduled?cron=*/1+*+*+*+*");
  } catch {}

  wrangler.on("exit", () => {
    clearInterval(interval);
    process.exit();
  });
}

main();
