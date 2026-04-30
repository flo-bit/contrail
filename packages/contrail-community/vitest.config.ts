import { defineConfig } from "vitest/config";
import path from "node:path";

const contrailSrc = path.resolve(__dirname, "../contrail/src");

// Alias `@atmo-dev/contrail` and its subpaths to the source so tests don't
// run through the built dist. Mirrors the in-tree-source-resolution pattern
// the contrail package's own tests use (they import via ../src/...).
export default defineConfig({
  resolve: {
    alias: {
      "@atmo-dev/contrail/sqlite": path.join(contrailSrc, "adapters/sqlite.ts"),
      "@atmo-dev/contrail/postgres": path.join(contrailSrc, "adapters/postgres.ts"),
      "@atmo-dev/contrail": path.join(contrailSrc, "index.ts"),
    },
  },
});
