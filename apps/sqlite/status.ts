import { Contrail, getStatusOverview } from "@atmo-dev/contrail";
import { getAlluviumBootstrapState } from "@atmo-dev/contrail/alluvium";
import { config } from "./contrail.config";
import { databasePath, openDatabase } from "./database";

const db = openDatabase();
const contrail = new Contrail({ ...config, db });
await contrail.init();

const bootstrap = await getAlluviumBootstrapState(db);
console.log(
  JSON.stringify(
    {
      database: databasePath,
      ...(await getStatusOverview(db, contrail.config)),
      bootstrap: bootstrap && {
        phase: bootstrap.phase,
        endpoint: bootstrap.endpoint,
        liveCursorUs: bootstrap.liveCursorUs,
        after: bootstrap.after,
      },
    },
    null,
    2,
  ),
);
