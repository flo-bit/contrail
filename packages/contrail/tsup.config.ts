import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server.ts",
    "src/adapters/sqlite.ts",
    "src/adapters/postgres.ts",
    "src/workers/backfill.ts",
    "src/worker/index.ts",
    "src/cli.ts",
    "src/cli-config.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  tsconfig: "tsconfig.build.json",
  external: ["node:sqlite", "pg", "wrangler"],
});
