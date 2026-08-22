import { fail, redirect } from "@sveltejs/kit";
import {
  SpacesProviderClient,
  addSimpleSpaceMember,
  createSpace,
  createSpaceRecord,
  formatSpaceUri,
  listSimpleSpaceMembers,
  removeSimpleSpaceMember,
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

interface CircleMember {
  did: string;
  handle?: string;
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

async function resolveMember(value: unknown): Promise<{ did: string; handle?: string }> {
  if (validDid(value)) return { did: value };
  const handle = typeof value === "string"
    ? value.trim().replace(/^@/, "").toLowerCase()
    : "";
  if (!handle || handle.length > 253) throw new Error("Enter a valid handle or DID");
  const url = new URL(
    "/xrpc/com.atproto.identity.resolveHandle",
    "https://public.api.bsky.app",
  );
  url.searchParams.set("handle", handle);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Could not resolve @${handle}`);
  const result = await response.json() as { did?: unknown };
  if (!validDid(result.did)) throw new Error(`Could not resolve @${handle}`);
  return { did: result.did, handle };
}

async function profileHandle(did: string): Promise<string | undefined> {
  const url = new URL("/xrpc/app.bsky.actor.getProfile", "https://public.api.bsky.app");
  url.searchParams.set("actor", did);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const profile = await response.json() as { handle?: unknown };
    return typeof profile.handle === "string" ? profile.handle : undefined;
  } catch {
    return undefined;
  }
}

async function nativeMembers(
  session: NonNullable<App.Locals["session"]>,
  space: string,
): Promise<CircleMember[]> {
  const dids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listSimpleSpaceMembers(session, { space, cursor, limit: 100 });
    dids.push(...page.members.map((member) => member.did));
    cursor = page.cursor;
  } while (cursor && dids.length < 1_000);
  const members = await Promise.all(dids.map(async (did) => ({
    did,
    handle: await profileHandle(did),
  })));
  return members;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.session || !locals.did) {
    return {
      signedIn: false as const,
      owner: null,
      space: null,
      notes: [],
      members: [],
      circles: [],
    };
  }
  const ownerParam = url.searchParams.get("owner");
  const owner = validDid(ownerParam) ? ownerParam : locals.did;
  const space = circleUri(owner);
  const client = provider(locals.session);
  const available = await client.listSpaces({ limit: 200 }).catch(() => ({
    spaces: [] as Array<{ uri: string; authorityDid: string; type: string }>,
    truncated: false,
  }));
  const members = owner === locals.did
    ? await nativeMembers(locals.session, space).catch(() => [] as CircleMember[])
    : [] as CircleMember[];
  const queryNotes = () => client.listSpaceRecords<NoteRecord>({
    space,
    collection: NOTE_COLLECTION,
    limit: 100,
    search: url.searchParams.get("search") ?? undefined,
  });
  try {
    let notes;
    try {
      notes = await queryNotes();
    } catch {
      // Native PDS policy remains authoritative. Renew the short provider
      // lease only when cached access expires; removed members fail here.
      await client.authorizeSpace(space);
      notes = await queryNotes();
    }
    return {
      signedIn: true as const,
      owner,
      space,
      notes: notes.records,
      members,
      circles: available.spaces,
      circlesTruncated: available.truncated,
      viewer: locals.did,
      needsAuthorization: false,
    };
  } catch (error) {
    return {
      signedIn: true as const,
      owner,
      space,
      notes: [] as NoteRecord[],
      members,
      circles: available.spaces,
      circlesTruncated: available.truncated,
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
        policy: { kind: "member-list" },
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

  async addMember({ request, locals }) {
    const { session, did } = signedIn(locals);
    const form = await request.formData();
    const owner = ownerFrom(form, did);
    if (owner !== did) {
      return fail(403, { action: "addMember", message: "Only the circle owner can add members" });
    }
    try {
      const member = await resolveMember(form.get("member"));
      if (member.did === owner) throw new Error("The owner already has access");
      await addSimpleSpaceMember(session, circleUri(owner), member.did);
    } catch (error) {
      return fail(400, {
        action: "addMember",
        message: error instanceof Error ? error.message : "Could not add member",
      });
    }
    throw redirect(303, `/?owner=${encodeURIComponent(owner)}`);
  },

  async removeMember({ request, locals }) {
    const { session, did } = signedIn(locals);
    const form = await request.formData();
    const owner = ownerFrom(form, did);
    const memberDid = form.get("memberDid");
    if (owner !== did) {
      return fail(403, {
        action: "removeMember",
        message: "Only the circle owner can remove members",
      });
    }
    if (!validDid(memberDid)) {
      return fail(400, { action: "removeMember", message: "Invalid member DID" });
    }
    try {
      const space = circleUri(owner);
      await removeSimpleSpaceMember(session, space, memberDid);
    } catch (error) {
      return fail(400, {
        action: "removeMember",
        message: error instanceof Error ? error.message : "Could not remove member",
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
