/** Candidate-generation Worker entrypoint. Switch wrangler `main` to this file
 * only while activating a fresh D1 + Meilisearch index generation. */
import { createWorker } from "@atmo-dev/contrail/worker";
import { lexicons } from "../lexicons/generated";
import { searchGenerationConfig } from "./contrail.config";
import {
  createAtmoMeilisearchRuntime,
  type AtmoMeilisearchEnv,
} from "./meilisearch";

type Env = AtmoMeilisearchEnv & Record<string, unknown>;
const search = createAtmoMeilisearchRuntime<Env>();

export default createWorker<Env>(searchGenerationConfig, {
  lexicons,
  publicService: { endpoint: "https://api.atmo.rsvp" },
  ...search,
});
