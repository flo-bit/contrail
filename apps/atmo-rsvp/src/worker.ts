import { createWorker } from "@atmo-dev/contrail/worker";
import { lexicons } from "../lexicons/generated";
import { config } from "./contrail.config";

export default createWorker(config, {
  lexicons,
  publicService: {
    endpoint: "https://api.atmo.rsvp",
  },
});
