import { afterAll, afterEach } from "vitest";
import {
  closeAllPgliteDatabases,
  resetLeasedPgliteDatabases,
} from "./pglite";

if (process.env.CONTRAIL_TEST_DIALECT === "postgres") {
  afterEach(async () => {
    await resetLeasedPgliteDatabases();
  });

  afterAll(async () => {
    await closeAllPgliteDatabases();
  });
}
