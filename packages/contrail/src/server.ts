import { Client } from "@atcute/client";
import type { Database } from "./core/types";
import type { Contrail } from "./contrail";
import type { PublicServiceOptions } from "./public-service";

export interface CreateHandlerOptions {
  /** Bundled Lexicon documents exposed by the HTTP app. */
  lexicons?: object[];
  /** Enable stable discovery and Lexicon routes for anonymous remote clients. */
  publicService?: PublicServiceOptions;
}

/** Create a fetch handler, optionally accepting a per-request database binding. */
export function createHandler(
  contrail: Contrail,
  options: CreateHandlerOptions = {},
): (request: Request, db?: Database) => Promise<Response> {
  let cached: ((request: Request) => Promise<Response>) | null = null;
  return (request: Request, db?: Database) => {
    if (db) {
      return contrail.handler({
        db,
        lexicons: options.lexicons,
        publicService: options.publicService,
      })(request);
    }
    cached ??= contrail.handler({
      lexicons: options.lexicons,
      publicService: options.publicService,
    });
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
