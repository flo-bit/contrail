/**
 * Persistent Jetstream ingestion with runtime configuration.
 *
 * Connects to an externally-provided database and subscribes to Jetstream.
 * The container does not own the database — it receives a connection URL.
 *
 * Environment:
 *   JETSTREAM_URL      - Jetstream WebSocket URL (required)
 *   CONTRAIL_ADAPTER   - "postgres" or "sqlite" (default: "postgres")
 *   DATABASE_URL       - PostgreSQL connection string (required when adapter=postgres)
 *   SQLITE_PATH        - SQLite file path (required when adapter=sqlite)
 *   CONTRAIL_CONFIG    - Path to config file (default: "/app/config/contrail.config.ts")
 *   FLUSH_INTERVAL_MS  - Batch flush interval in ms (default: 500)
 */

import { Contrail } from "../src/index.ts";
import type { ContrailConfig, Database } from "../src/index.ts";

const ADAPTER = process.env.CONTRAIL_ADAPTER ?? "postgres";
const JETSTREAM_URL = process.env.JETSTREAM_URL;
const CONFIG_PATH = process.env.CONTRAIL_CONFIG ?? "/app/config/contrail.config.ts";
const FLUSH_INTERVAL_MS = parseInt(process.env.FLUSH_INTERVAL_MS ?? "500", 10);

async function createDatabase(): Promise<{ db: Database; cleanup: () => Promise<void> }> {
  if (ADAPTER === "postgres") {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("DATABASE_URL is required when CONTRAIL_ADAPTER=postgres");
      process.exit(1);
    }
    const pg = await import("pg");
    const { createPostgresDatabase } = await import("../src/adapters/postgres.ts");
    const pool = new pg.default.Pool({ connectionString: url });
    return { db: createPostgresDatabase(pool), cleanup: () => pool.end() };
  }

  if (ADAPTER === "sqlite") {
    const path = process.env.SQLITE_PATH;
    if (!path) {
      console.error("SQLITE_PATH is required when CONTRAIL_ADAPTER=sqlite");
      process.exit(1);
    }
    const { createSqliteDatabase } = await import("../src/adapters/sqlite.ts");
    return { db: createSqliteDatabase(path), cleanup: async () => {} };
  }

  console.error(`Unknown adapter: ${ADAPTER}. Use "postgres" or "sqlite".`);
  process.exit(1);
}

async function loadConfig(): Promise<ContrailConfig> {
  const module = await import(CONFIG_PATH);
  return module.config ?? module.default;
}

async function main() {
  if (!JETSTREAM_URL) {
    console.error("JETSTREAM_URL is required");
    process.exit(1);
  }

  const config = await loadConfig();
  config.jetstreams = [JETSTREAM_URL];

  const { db, cleanup } = await createDatabase();
  const contrail = new Contrail({ ...config, db });

  const controller = new AbortController();
  const shutdown = () => {
    console.log("\nShutting down gracefully...");
    controller.abort();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("Contrail ingester starting");
  console.log(`  Adapter:   ${ADAPTER}`);
  console.log(`  Jetstream: ${JETSTREAM_URL}`);
  console.log(`  Config:    ${CONFIG_PATH}`);
  console.log(`  Flush:     ${FLUSH_INTERVAL_MS}ms`);

  await contrail.runPersistent({
    signal: controller.signal,
    flushIntervalMs: FLUSH_INTERVAL_MS,
  });

  await cleanup();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
