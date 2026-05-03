import { defineConfig } from "vitest/config";
import path from "node:path";

const baseSrc = path.resolve(__dirname, "../contrail-base/src");
const authoritySrc = path.resolve(__dirname, "../contrail-authority/src");
const recordHostSrc = path.resolve(__dirname, "../contrail-record-host/src");
const appviewSrc = path.resolve(__dirname, "../contrail-appview/src");

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // PostgreSQL tests share a single database and cannot run in parallel
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // Resolve workspace-internal contrail-* subpaths to source so tests
      // don't run through the dists (where tsup drops `node:` prefixes).
      "@atmo-dev/contrail-base/sqlite": path.join(baseSrc, "adapters/sqlite.ts"),
      "@atmo-dev/contrail-base/postgres": path.join(baseSrc, "adapters/postgres.ts"),
      "@atmo-dev/contrail-base": path.join(baseSrc, "index.ts"),
      "@atmo-dev/contrail-authority": path.join(authoritySrc, "index.ts"),
      "@atmo-dev/contrail-record-host": path.join(recordHostSrc, "index.ts"),
      "@atmo-dev/contrail-appview": path.join(appviewSrc, "index.ts"),
    },
  },
});
