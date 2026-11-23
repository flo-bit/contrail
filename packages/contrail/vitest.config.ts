import { defineConfig } from "vitest/config";

const sharedRealPostgres = Boolean(process.env.TEST_DATABASE_URL);
const pgliteDialect = process.env.CONTRAIL_TEST_DIALECT === "postgres";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Only shared external PostgreSQL tests contend on one `public` schema.
    fileParallelism: !sharedRealPostgres,
    ...(pgliteDialect
      ? { setupFiles: ["./tests/setup.ts"], maxWorkers: 3 }
      : {}),
  },
});
