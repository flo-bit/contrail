import { Contrail, getLastCursor } from "@atmo-dev/contrail";
import { config } from "./contrail.config";
import { databasePath, openDatabase } from "./database";

const db = openDatabase();
const contrail = new Contrail({ ...config, db });
await contrail.init();

const before = await getLastCursor(db);
await contrail.ingest({ timeoutMs: 15_000 });
const after = await getLastCursor(db);

console.log({ database: databasePath, cursorBefore: before, cursorAfter: after });
