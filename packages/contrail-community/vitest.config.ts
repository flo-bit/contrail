import { defineConfig } from "vitest/config";
import path from "node:path";

const contrailSrc = path.resolve(__dirname, "../contrail/src");
const baseSrc = path.resolve(__dirname, "../contrail-base/src");

// Resolve workspace-internal imports to source so tests don't run through
// dists (where tsup mangles `node:sqlite` → `sqlite`).
export default defineConfig({
  resolve: {
    alias: {
      "@atmo-dev/contrail-base/sqlite": path.join(baseSrc, "adapters/sqlite.ts"),
      "@atmo-dev/contrail-base/postgres": path.join(baseSrc, "adapters/postgres.ts"),
      "@atmo-dev/contrail-base": path.join(baseSrc, "index.ts"),
      "@atmo-dev/contrail/sqlite": path.join(contrailSrc, "adapters/sqlite.ts"),
      "@atmo-dev/contrail/postgres": path.join(contrailSrc, "adapters/postgres.ts"),
      "@atmo-dev/contrail": path.join(contrailSrc, "index.ts"),
    },
  },
});
