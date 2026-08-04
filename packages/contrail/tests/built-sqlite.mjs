import assert from "node:assert/strict";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";

const db = createSqliteDatabase(":memory:");
const row = await db.prepare("SELECT 1 AS ok").first();
assert.equal(row?.ok, 1);
