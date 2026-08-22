import { fail, redirect } from "@sveltejs/kit";
import {
  addSimpleSpaceMember,
  createSpace,
  createSpaceRecord,
  formatSpaceUri,
  getDelegationToken,
  listSimpleSpaceMembers,
  removeSimpleSpaceMember,
} from "@atmo-dev/contrail-spaces-alpha/consumer";
import {
  NOTE_COLLECTION,
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
}

function circleUri(ownerDid: string): string {
  return formatSpaceUri({ authorityDid: ownerDid, type: SPACE_TYPE, skey: SPACE_SKEY });
}

function spacesRuntime(platform: App.Platform | undefined) {
  if (!platform) throw new Error("The integrated Spaces runtime requires a platform");
  return platform.env.SPACES_RUNTIME;
}

function notifySpaceWrite(
  platform: App.Platform | undefined,
  userDid: string,
  space: string,
): void {
  if (!platform) throw new Error("The integrated Spaces runtime requires a platform");
  platform.context.waitUntil(
    platform.env.SPACES_RUNTIME
      .syncSpace({ userDid, space, repo: userDid })
      .catch((error) => console.warn("Could not notify the Spaces projection", error)),
  );
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

async function resolveMember(value: unknown): Promise<{ did: string }> {
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
  return { did: result.did };
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
  return dids.map((did) => ({ did }));
}

export const load: PageServerLoad = async ({ locals, platform, url }) => {
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
  const runtime = spacesRuntime(platform);
  const availablePromise = runtime.listSpaces({
    userDid: locals.did,
    limit: 200,
  }).catch(() => ({
    spaces: [] as Array<{ uri: string; authorityDid: string; type: string }>,
    truncated: false,
  }));
  const membersPromise = owner === locals.did
    ? nativeMembers(locals.session, space).catch(() => [] as CircleMember[])
    : Promise.resolve([] as CircleMember[]);
  const queryNotes = () => runtime.listSpaceRecords<NoteRecord>({
    userDid: locals.did!,
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
      // Native PDS policy remains authoritative. Renew the short projection
      // lease only when cached access expires; removed members fail here.
      await runtime.authorizeSpace({
        userDid: locals.did,
        space,
        delegation: await getDelegationToken(locals.session, space),
      });
      notes = await queryNotes();
    }
    const [available, members] = await Promise.all([availablePromise, membersPromise]);
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
    const [available, members] = await Promise.all([availablePromise, membersPromise]);
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
  async create({ locals, platform }) {
    const { session, did } = signedIn(locals);
    try {
      const created = await createSpace(session, {
        type: SPACE_TYPE,
        skey: SPACE_SKEY,
        policy: { kind: "member-list" },
      });
      await spacesRuntime(platform).authorizeSpace({
        userDid: did,
        space: created.uri,
        delegation: await getDelegationToken(session, created.uri),
      });
    } catch (error) {
      return fail(400, {
        action: "create",
        message: error instanceof Error ? error.message : "Could not create circle",
      });
    }
    throw redirect(303, `/?owner=${encodeURIComponent(did)}`);
  },

  async authorize({ request, locals, platform }) {
    const { session, did } = signedIn(locals);
    const form = await request.formData();
    const owner = ownerFrom(form, did);
    try {
      const space = circleUri(owner);
      await spacesRuntime(platform).authorizeSpace({
        userDid: did,
        space,
        delegation: await getDelegationToken(session, space),
      });
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

  async post({ request, locals, platform }) {
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
      notifySpaceWrite(platform, did, space);
    } catch (error) {
      return fail(400, {
        action: "post",
        message: error instanceof Error ? error.message : "Could not post note",
      });
    }
    throw redirect(303, `/?owner=${encodeURIComponent(owner)}`);
  },

  async react({ request, locals, platform }) {
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
      notifySpaceWrite(platform, did, space);
    } catch (error) {
      return fail(400, {
        action: "react",
        message: error instanceof Error ? error.message : "Could not react",
      });
    }
    throw redirect(303, `/?owner=${encodeURIComponent(owner)}`);
  },
};
