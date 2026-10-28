import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Contrail } from "@atmo-dev/contrail";
import { createPgliteDatabase } from "@atmo-dev/contrail/pglite";

const pglite = new PGlite();
try {
  const db = createPgliteDatabase(pglite);
  assert.equal((await db.prepare("SELECT ?::int AS ok").bind(1).first())?.ok, 1);
  await db.prepare("CREATE TABLE smoke (id INTEGER PRIMARY KEY)").run();
  assert.deepEqual(await db.prepare("INSERT INTO smoke VALUES (?)").bind(1).run(), { changes: 1 });
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO smoke VALUES (?)").bind(2),
    db.prepare("INSERT INTO smoke VALUES (?)").bind(1),
  ]));
  assert.deepEqual((await db.prepare("SELECT * FROM smoke").all()).results, [{ id: 1 }]);

  const contrail = new Contrail({ namespace: "smoke", collections: {}, db });
  await contrail.init();
  const response = await contrail.app().fetch(new Request("http://localhost/status"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).backfill.state, "complete");
} finally {
  await pglite.close();
}
