import assert from "node:assert/strict";
import { Contrail } from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import * as workers from "@atmo-dev/contrail/workers";

assert.equal("refresh" in Contrail.prototype, false);
assert.equal("refresh" in workers, false);

const db = createSqliteDatabase(":memory:");
const row = await db.prepare("SELECT 1 AS ok").first();
assert.equal(row?.ok, 1);
