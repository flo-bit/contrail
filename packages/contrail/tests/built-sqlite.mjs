import assert from "node:assert/strict";
import { Contrail } from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import * as workers from "@atmo-dev/contrail/workers";

assert.equal("refresh" in Contrail.prototype, false);
assert.equal("refresh" in workers, false);

const db = createSqliteDatabase(":memory:");
const row = await db.prepare("SELECT 1 AS ok").first();
assert.equal(row?.ok, 1);

const contrail = new Contrail({ namespace: "smoke", collections: {}, db });
await contrail.init();
const statusResponse = await contrail
  .app()
  .fetch(new Request("http://localhost/status"));
assert.equal(statusResponse.status, 200);
const status = await statusResponse.json();
assert.equal(status.backfill.state, "complete");
