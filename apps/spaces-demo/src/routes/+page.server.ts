import { fail, redirect } from "@sveltejs/kit";
import {
  SpacesProviderClient,
  createSpace,
  createSpaceRecord,
  formatSpaceUri,
} from "@atmo-dev/contrail-spaces-alpha/consumer";
import {
  NOTE_COLLECTION,
  PROVIDER_AUDIENCE,
  PROVIDER_ENDPOINT,
  REACTION_COLLECTION,
  SPACE_SKEY,
  SPACE_TYPE,
} from "$lib/constants";
import type { Actions, PageServerLoad } from "./$types";

interface NoteRecord {
  uri: string;
  did: string;
  cid: string;
  counts?: Record<string, number>;
  value: {
    text: string;
    createdAt: string;
    reply?: { uri: string; cid: string };
  };
}

function circleUri(ownerDid: string): string {
  return formatSpaceUri({ authorityDid: ownerDid, type: SPACE_TYPE, skey: SPACE_SKEY });
}

function provider(session: NonNullable<App.Locals["session"]>) {
  return new SpacesProviderClient({
    endpoint: PROVIDER_ENDPOINT,
    audience: PROVIDER_AUDIENCE,
    namespace: SPACE_TYPE,
    session,
  });
}

function signedIn(locals: App.Locals) {
  if (!locals.session || !locals.did) throw redirect(303, "/");
  return { session: locals.session, did: locals.did };
}

function validDid(value: unknown): value is string {
  return typeof value === "string" && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value);
}

function ownerFrom(form: FormData, fallback: string): string {
  const owner = form.get("owner");
  return validDid(owner) ? owner : fallback;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.session || !locals.did) {
    return { signedIn: false as const, owner: null, space: null, notes: [] };
  }
  const ownerParam = url.searchParams.get("owner");
  const owner = validDid(ownerParam) ? ownerParam : locals.did;
  const space = circleUri(owner);
  try {
    const result = await provider(locals.session).listSpaceRecords<NoteRecord>({
      space,
      collection: NOTE_COLLECTION,
      limit: 100,
      search: url.searchParams.get("search") ?? undefined,
    });
    return {
      signedIn: true as const,
      owner,
      space,
      notes: result.records,
      viewer: locals.did,
      needsAuthorization: false,
    };
  } catch (error) {
    return {
      signedIn: true as const,
      owner,
      space,
      notes: [] as NoteRecord[],
      viewer: locals.did,
      needsAuthorization: true,
      error: error instanceof Error ? error.message : "Circle unavailable",
    };
  }
};

export const actions: Actions = {
  async create({ locals }) {
    const { session, did } = signedIn(locals);
    try {
      const created = await createSpace(session, {
        type: SPACE_TYPE,
        skey: SPACE_SKEY,
        managingApp: PROVIDER_AUDIENCE,
      });
      await provider(session).authorizeSpace(created.uri);
    } catch (error) {
      return fail(400, {
        action: "create",
        message: error instanceof Error ? error.message : "Could not create circle",
      });
    }
    throw redirect(303, `/?owner=${encodeURIComponent(did)}`);
  },

  async authorize({ request, locals }) {
    const { session, did } = signedIn(locals);
    const form = await request.formData();
    const owner = ownerFrom(form, did);
    try {
      await provider(session).authorizeSpace(circleUri(owner));
    } catch (error) {
      return fail(403, {
        action: "authorize",
        message: error instanceof Error ? error.message : "Circle access denied",
      });
    }
    throw redirect(303, `/?owner=${encodeURIComponent(owner)}`);
  },

  async post({ request, locals }) {
    const { session, did } = signedIn(locals);
    const form = await request.formData();
    const owner = ownerFrom(form, did);
    const text = String(form.get("text") ?? "").trim();
    if (!text || text.length > 2000) {
      return fail(400, { action: "post", message: "Note must be 1–2000 characters" });
    }
    const replyUri = form.get("replyUri");
    const replyCid = form.get("replyCid");
    try {
      const space = circleUri(owner);
      await createSpaceRecord(session, {
        space,
        collection: NOTE_COLLECTION,
        record: {
          $type: NOTE_COLLECTION,
          text,
          createdAt: new Date().toISOString(),
          ...(typeof replyUri === "string" && replyUri &&
            typeof replyCid === "string" && replyCid
            ? { reply: { uri: replyUri, cid: replyCid } }
            : {}),
        },
      });
      await provider(session).syncSpace(space, did);
    } catch (error) {
      return fail(400, {
        action: "post",
        message: error instanceof Error ? error.message : "Could not post note",
      });
    }
    throw redirect(303, `/?owner=${encodeURIComponent(owner)}`);
  },

  async react({ request, locals }) {
    const { session, did } = signedIn(locals);
    const form = await request.formData();
    const owner = ownerFrom(form, did);
    const uri = String(form.get("uri") ?? "");
    const cid = String(form.get("cid") ?? "");
    if (!uri || !cid) return fail(400, { action: "react", message: "Invalid note" });
    try {
      const space = circleUri(owner);
      await createSpaceRecord(session, {
        space,
        collection: REACTION_COLLECTION,
        record: {
          $type: REACTION_COLLECTION,
          subject: { uri, cid },
          createdAt: new Date().toISOString(),
        },
      });
      await provider(session).syncSpace(space, did);
    } catch (error) {
      return fail(400, {
        action: "react",
        message: error instanceof Error ? error.message : "Could not react",
      });
    }
    throw redirect(303, `/?owner=${encodeURIComponent(owner)}`);
  },
};
