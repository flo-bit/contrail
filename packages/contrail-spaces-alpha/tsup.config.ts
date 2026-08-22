import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker.ts", "src/consumer.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
  tsconfig: "tsconfig.build.json",
  external: ["node:sqlite", "pg", "wrangler"],
  removeNodeProtocol: false,
});
