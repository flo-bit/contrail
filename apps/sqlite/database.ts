import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";

export const databasePath = fileURLToPath(
  new URL("./data/contrail.sqlite", import.meta.url),
);

export function openDatabase() {
  mkdirSync(dirname(databasePath), { recursive: true });
  return createSqliteDatabase(databasePath);
}
