import { defineConfig } from "vitest/config";
import path from "node:path";

const baseSrc = path.resolve(__dirname, "../contrail-base/src");

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // PostgreSQL tests share a single database and cannot run in parallel
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // Resolve workspace-internal contrail-base subpaths to source so tests
      // don't run through the dist (where tsup drops `node:` prefixes).
      "@atmo-dev/contrail-base/sqlite": path.join(baseSrc, "adapters/sqlite.ts"),
      "@atmo-dev/contrail-base/postgres": path.join(baseSrc, "adapters/postgres.ts"),
      "@atmo-dev/contrail-base": path.join(baseSrc, "index.ts"),
    },
  },
});
