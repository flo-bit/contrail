import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // PostgreSQL tests share a single database and cannot run in parallel
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // Point at contrail-community's source so tests don't require a built
      // dist. Mirrors the contrail-community package's own vitest alias for
      // `@atmo-dev/contrail` → contrail/src.
      "@atmo-dev/contrail-community": path.resolve(
        __dirname,
        "../contrail-community/src/index.ts"
      ),
    },
  },
});
