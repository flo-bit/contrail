import { describe, it, expect } from "vitest";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { initCommunitySchema } from "../src/schema";

describe("provision_attempts schema", () => {
  it("enforces status enum", async () => {
    const db = createSqliteDatabase(":memory:");
    await initCommunitySchema(db);
    await expect(
      db
        .prepare(
          "INSERT INTO provision_attempts (attempt_id, did, status, created_at, updated_at, pds_endpoint, handle, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("a1", "did:plc:x", "bogus", 1, 1, "https://pds", "h.test", "x@x")
        .run()
    ).rejects.toThrow();
  });
});
