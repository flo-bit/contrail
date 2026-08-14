import {
  Contrail,
  DatabaseBootstrapTarget,
  getBootstrapVerification,
  getStatusOverview,
} from "@atmo-dev/contrail";
import { config } from "./contrail.config";
import { databasePath, openDatabase } from "./database";

const db = openDatabase();
const contrail = new Contrail({ ...config, db });
await contrail.init();

const bootstrap = await new DatabaseBootstrapTarget(db, contrail.config).load();
console.log(
  JSON.stringify(
    {
      database: databasePath,
      ...(await getStatusOverview(db, contrail.config)),
      bootstrap: bootstrap && {
        phase: bootstrap.phase,
        captureFrom: bootstrap.captureFrom,
        catchupThrough: bootstrap.catchupThrough,
        changeCheckpoint: bootstrap.changeCheckpoint,
      },
      verification: await getBootstrapVerification(db),
    },
    null,
    2,
  ),
);
