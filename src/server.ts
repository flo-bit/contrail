import type { Contrail } from "./contrail";
import type { Database } from "./core/types";

/**
 * Create an HTTP handler from a Contrail instance.
 *
 * Thin wrapper over `contrail.handler()` that accepts per-request DB overrides
 * (useful on Cloudflare Workers where the DB binding lives on the request env).
 *
 *   const handle = createHandler(contrail);
 *   // SvelteKit: export const GET = ({ request }) => handle(request);
 *   // Workers:   return handle(request, env.DB, env.SPACES_DB);
 *
 * For most cases, prefer `contrail.handler()` directly when DBs are bound at
 * construction time.
 */
export function createHandler(
  contrail: Contrail
): (request: Request, db?: Database, spacesDb?: Database) => Promise<Response> {
  // When no per-request DBs are provided, build the app once and reuse it.
  let cached: ((request: Request) => Promise<Response>) | null = null;
  return (request: Request, db?: Database, spacesDb?: Database) => {
    if (db || spacesDb) {
      return contrail.handler({ db, spacesDb })(request);
    }
    cached ??= contrail.handler();
    return cached(request);
  };
}
