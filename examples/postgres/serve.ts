/**
 * Serve the Contrail XRPC API over HTTP using PostgreSQL.
 *
 * Usage:
 *   DATABASE_URL="postgresql://contrail:contrail@localhost:5432/contrail" npx tsx serve.ts
 */
import pg from "pg";
import { createServer } from "node:http";
import { Contrail } from "contrail";
import { createHandler } from "contrail/server";
import { createPostgresDatabase } from "contrail/postgres";
import { config } from "./config";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://contrail:contrail@localhost:5433/contrail";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = createPostgresDatabase(pool);
  const contrail = new Contrail({ ...config, db });

  await contrail.init();

  const handle = createHandler(contrail);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);
    const request = new Request(url.toString(), {
      method: req.method,
      headers: Object.entries(req.headers).reduce(
        (h, [k, v]) => {
          if (v) h[k] = Array.isArray(v) ? v.join(", ") : v;
          return h;
        },
        {} as Record<string, string>,
      ),
    });

    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });

  server.listen(PORT, () => {
    console.log(`Contrail XRPC API listening on http://localhost:${PORT}`);
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
