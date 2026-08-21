import { json } from "@sveltejs/kit";
import {
  SpacesProviderClient,
  formatSpaceUri,
} from "@atmo-dev/contrail-spaces-alpha/consumer";
import {
  PROVIDER_AUDIENCE,
  PROVIDER_ENDPOINT,
  SPACE_SKEY,
  SPACE_TYPE,
} from "$lib/constants";
import type { RequestHandler } from "./$types";

function validDid(value: unknown): value is string {
  return typeof value === "string" && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value);
}

export const POST: RequestHandler = async ({ locals, request }) => {
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
    const subscription = await new SpacesProviderClient({
      endpoint: PROVIDER_ENDPOINT,
      audience: PROVIDER_AUDIENCE,
      namespace: SPACE_TYPE,
      session: locals.session,
    }).subscribeSpace(space);
    return json(subscription, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    console.warn("Could not open Space subscription", error);
    return json({ error: "Live updates unavailable" }, { status: 502 });
  }
};
