import { Client } from "@atcute/client";
import type { Database } from "./core/types";
import type { Contrail } from "./contrail";
import type { PublicServiceOptions } from "./public-service";

export interface CreateHandlerOptions {
  /** Bundled Lexicon documents exposed by the HTTP app. */
  lexicons?: object[];
  /** Enable stable discovery and Lexicon routes for anonymous remote clients. */
  publicService?: PublicServiceOptions;
  reportsDb?: Database;
}

/** Create a fetch handler, optionally accepting a per-request database binding. */
export function createHandler(
  contrail: Contrail,
  options: CreateHandlerOptions = {},
): (request: Request, db?: Database, reportsDb?: Database) => Promise<Response> {
  let cached: ((request: Request) => Promise<Response>) | null = null;
  return (request: Request, db?: Database, reportsDb?: Database) => {
    // Per-request bindings are never cached: a later request may pass others.
    if (db || reportsDb) {
      return contrail.handler({
        ...(db ? { db } : {}),
        reportsDb: reportsDb ?? options.reportsDb,
        lexicons: options.lexicons,
        publicService: options.publicService,
      })(request);
    }
    cached ??= contrail.handler({
      reportsDb: options.reportsDb,
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
