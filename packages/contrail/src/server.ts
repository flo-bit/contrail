import { Client } from "@atcute/client";
import type { Database } from "./core/types";
import type { Contrail } from "./contrail";

export interface CreateHandlerOptions {
  /** Bundled Lexicon documents exposed by the HTTP app. */
  lexicons?: object[];
}

/** Create a fetch handler, optionally accepting a per-request database binding. */
export function createHandler(
  contrail: Contrail,
  options: CreateHandlerOptions = {},
): (request: Request, db?: Database) => Promise<Response> {
  let cached: ((request: Request) => Promise<Response>) | null = null;
  return (request: Request, db?: Database) => {
    if (db) {
      return contrail.handler({ db, lexicons: options.lexicons })(request);
    }
    cached ??= contrail.handler({ lexicons: options.lexicons });
    return cached(request);
  };
}

/** Create an Atcute client that sends requests directly to a Contrail handler. */
export function createServerClient(
  handle: (request: Request) => Promise<Response>,
): Client {
  return new Client({
    handler: async (pathname, init) =>
      handle(new Request(new URL(pathname, "http://localhost"), init)),
  });
}
