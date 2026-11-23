/**
 * Serve the Contrail XRPC API over HTTP using PostgreSQL.
 *
 * Usage:
 *   DATABASE_URL="postgresql://contrail:contrail@localhost:5432/contrail" pnpm exec tsx serve.ts
 */
import pg from "pg";
import { createServer } from "node:http";
import { Contrail } from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import { config } from "./contrail.config";

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
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    let body: Buffer | undefined;
    if (hasBody) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      body = Buffer.concat(chunks);
    }
    const request = new Request(url.toString(), {
      method,
      headers: Object.entries(req.headers).reduce(
        (h, [k, v]) => {
          if (v) h[k] = Array.isArray(v) ? v.join(", ") : v;
          return h;
        },
        {} as Record<string, string>,
      ),
      ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
    });

    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
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
