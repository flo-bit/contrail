/**
 * Persistent Jetstream ingestion against PostgreSQL.
 *
 * Opens a long-lived Jetstream connection and continuously indexes new records.
 * Events are batched and flushed periodically. Handles reconnection automatically.
 *
 * Usage:
 *   DATABASE_URL="postgresql://contrail:contrail@localhost:5432/contrail" npx tsx ingest.ts
 */
import pg from "pg";
import { Contrail } from "@atmo-dev/contrail";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import { config } from "./config";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://contrail:contrail@localhost:5433/contrail";

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = createPostgresDatabase(pool);
  const contrail = new Contrail({ ...config, db });

  const controller = new AbortController();
  const shutdown = () => {
    console.log("\nShutting down gracefully...");
    controller.abort();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("Starting persistent ingestion...");
  await contrail.runPersistent({ signal: controller.signal });

  await pool.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
