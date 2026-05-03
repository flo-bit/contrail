import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  tsconfig: "tsconfig.build.json",
  external: [
    "@atmo-dev/contrail-base",
    "@atmo-dev/contrail-authority",
    "@atmo-dev/contrail-record-host",
  ],
});
