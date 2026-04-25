import { Client } from "@atcute/client";
import type { Contrail } from "./contrail";
import type { Database } from "./core/types";
import { markInProcess } from "./core/spaces/in-process";

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
export interface CreateHandlerOptions {
  /** Bundled lexicon JSONs — if provided, served at `/lexicons` so
   *  consumer apps can fetch + typegen against this deployment. Generate
   *  with `contrail-lex generate` and import from `lexicons/generated`. */
  lexicons?: object[];
}

export function createHandler(
  contrail: Contrail,
  options: CreateHandlerOptions = {}
): (request: Request, db?: Database, spacesDb?: Database) => Promise<Response> {
  // When no per-request DBs are provided, build the app once and reuse it.
  let cached: ((request: Request) => Promise<Response>) | null = null;
  return (request: Request, db?: Database, spacesDb?: Database) => {
    if (db || spacesDb) {
      return contrail.handler({ db, spacesDb, lexicons: options.lexicons })(request);
    }
    cached ??= contrail.handler({ lexicons: options.lexicons });
    return cached(request);
  };
}

/**
 * Fully typed `@atcute/client` Client that routes XRPC calls through a
 * contrail handler in-process — no HTTP roundtrip, no JWT minting.
 *
 * Pass `did` to act as that user; omit for anonymous calls (public endpoints
 * only). Authentication is via the in-process WeakMap marker, which is
 * unforgeable across network boundaries.
 *
 *   // Same-process on Cloudflare Workers (per-request DB):
 *   const client = createServerClient(
 *     (req) => contrail.handler({ db: env.DB })(req),
 *     session.did,
 *   );
 *   await client.post('tools.atmo.chat.space.putRecord', { input: { ... } });
 */
export function createServerClient(
  handle: (req: Request) => Promise<Response>,
  did?: string
): Client {
  return new Client({
    handler: async (pathname, init) => {
      const req = new Request(new URL(pathname, "http://localhost"), init);
      if (did !== undefined) markInProcess(req, did);
      return handle(req);
    },
  });
}

export { markInProcess };
