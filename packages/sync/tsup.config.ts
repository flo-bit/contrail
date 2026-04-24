import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cache-idb.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  tsconfig: "tsconfig.build.json",
});
