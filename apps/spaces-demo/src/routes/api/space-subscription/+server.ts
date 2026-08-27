import { json } from "@sveltejs/kit";
import {
  formatSpaceUri,
  getDelegationToken,
} from "@atmo-dev/contrail-spaces-alpha/consumer";
import { SPACE_SKEY, SPACE_TYPE } from "$lib/constants";
import type { RequestHandler } from "./$types";

function validDid(value: unknown): value is string {
  return typeof value === "string" && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value);
}

export const POST: RequestHandler = async ({ locals, platform, request, url }) => {
  if (!locals.session || !locals.did) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null) as { owner?: unknown } | null;
  if (!validDid(body?.owner)) {
    return json({ error: "Invalid owner DID" }, { status: 400 });
  }
  const space = formatSpaceUri({
    authorityDid: body.owner,
    type: SPACE_TYPE,
    skey: SPACE_SKEY,
  });
  try {
    if (!platform) throw new Error("The integrated Spaces runtime requires a platform");
    const runtime = platform.env.SPACES_RUNTIME;
    let subscription;
    try {
      subscription = await runtime.subscribeSpace({
        userDid: locals.did,
        space,
        endpoint: url.origin,
      });
    } catch {
      await runtime.authorizeSpace({
        userDid: locals.did,
        space,
        delegation: await getDelegationToken(locals.session, space),
      });
      subscription = await runtime.subscribeSpace({
        userDid: locals.did,
        space,
        endpoint: url.origin,
      });
    }
    return json(subscription, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    console.warn("Could not open Space subscription", error);
    return json({ error: "Live updates unavailable" }, { status: 502 });
  }
};
