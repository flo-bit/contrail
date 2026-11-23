import { Client } from "@atcute/client";
import type { Hono } from "hono";
import type { Database } from "./core/types";
import type { Contrail } from "./contrail";
import type { PublicServiceOptions } from "./public-service";
import { REQUEST_DB, REQUEST_REPORTS_DB } from "./core/router";

export interface CreateHandlerOptions {
  /** Bundled Lexicon documents exposed by the HTTP app. */
  lexicons?: object[];
  /** Enable stable discovery and Lexicon routes for anonymous remote clients. */
  publicService?: PublicServiceOptions;
  reportsDb?: Database;
}

/** Create a fetch handler, optionally accepting a per-request database binding.
 *  Builds and caches the Hono router and validation context once per handler;
 *  per-request bindings are injected via Hono env and never retained across requests. */
export function createHandler(
  contrail: Contrail,
  options: CreateHandlerOptions = {},
): (
  request: Request,
  db?: Database,
  reportsDb?: Database,
  ctx?: ExecutionContext,
) => Promise<Response> {
  let cachedApp: Hono | null = null;
  return (
    request: Request,
    db?: Database,
    reportsDb?: Database,
    ctx?: ExecutionContext,
  ) => {
    if (!db && !contrail._hasDefaultDb()) {
      throw new Error(
        "No database provided. Pass db to constructor or to this method.",
      );
    }
    cachedApp ??= contrail._createRuntimeApp({
      reportsDb: options.reportsDb,
      lexicons: options.lexicons,
      publicService: options.publicService,
    });
    const env =
      db || reportsDb
        ? {
            ...(db ? { [REQUEST_DB]: db } : {}),
            ...(reportsDb ? { [REQUEST_REPORTS_DB]: reportsDb } : {}),
          }
        : undefined;
    return cachedApp.fetch(request, env, ctx) as Promise<Response>;
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
