import { createWorker } from "@atmo-dev/contrail/worker";
import { config } from "./contrail.config";
import { lexicons } from "../lexicons/generated";

export default createWorker(config, { lexicons });
