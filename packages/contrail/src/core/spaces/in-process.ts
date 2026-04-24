/** In-process auth marker.
 *
 *  For same-module callers (e.g. a SvelteKit worker that imports contrail and
 *  dispatches requests directly to the handler), service-auth JWTs are pure
 *  overhead: no network boundary is crossed, so there's nothing for the JWT to
 *  protect against. Instead, the caller tags the `Request` with a principal via
 *  a module-private WeakMap, and the auth middleware reads it back.
 *
 *  Security note: this is unforgeable from outside the module because
 *    - WeakMap keys are `Request` object identities, not serialized data;
 *    - no HTTP request crossing a network boundary can reach into this map;
 *    - exploiting it requires code execution inside the same isolate, at
 *      which point auth is already game over.
 *
 *  This is the strongest auth adapter contrail offers — it has no secret to
 *  leak. */

export interface InProcessPrincipal {
  did: string;
}

const PRINCIPALS = new WeakMap<Request, InProcessPrincipal>();

/** Tag a Request with an in-process principal. The returned Request is the
 *  same reference; the return value is for ergonomics. */
export function markInProcess(req: Request, did: string): Request {
  PRINCIPALS.set(req, { did });
  return req;
}

/** Read the in-process principal for a Request, or null if unmarked. */
export function readInProcess(req: Request): InProcessPrincipal | null {
  return PRINCIPALS.get(req) ?? null;
}
