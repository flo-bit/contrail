import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // PostgreSQL tests share one database and cannot run in parallel.
    fileParallelism: false,
  },
});
