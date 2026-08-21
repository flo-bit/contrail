import { fail, redirect } from "@sveltejs/kit";
import {
  SpacesProviderClient,
  createSpace,
  createSpaceRecord,
  deleteSpaceRecord,
  formatSpaceUri,
} from "@atmo-dev/contrail-spaces-alpha/consumer";
import {
  MEMBER_COLLECTION,
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

interface MemberRecord {
  uri: string;
  rkey: string;
  did: string;
  cid: string;
  value: {
    subject: string;
    handle?: string;
    createdAt: string;
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

async function memberRkey(did: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(did)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `m-${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
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
  try {
    const [notes, members] = await Promise.all([
      client.listSpaceRecords<NoteRecord>({
        space,
        collection: NOTE_COLLECTION,
        limit: 100,
        search: url.searchParams.get("search") ?? undefined,
      }),
      client.listSpaceRecords<MemberRecord>({
        space,
        collection: MEMBER_COLLECTION,
        did: owner,
        limit: 200,
      }),
    ]);
    return {
      signedIn: true as const,
      owner,
      space,
      notes: notes.records,
      members: members.records,
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
      members: [] as MemberRecord[],
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
      const space = circleUri(owner);
      const client = provider(session);
      const existing = await client.listSpaceRecords<MemberRecord>({
        space,
        collection: MEMBER_COLLECTION,
        did: owner,
        filters: { subject: member.did },
        limit: 1,
      });
      if (existing.records.length === 0) {
        await createSpaceRecord(session, {
          space,
          collection: MEMBER_COLLECTION,
          rkey: await memberRkey(member.did),
          record: {
            $type: MEMBER_COLLECTION,
            subject: member.did,
            ...(member.handle ? { handle: member.handle } : {}),
            createdAt: new Date().toISOString(),
          },
        });
        await client.syncSpace(space, did);
      }
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
    const rkey = form.get("rkey");
    if (owner !== did) {
      return fail(403, {
        action: "removeMember",
        message: "Only the circle owner can remove members",
      });
    }
    if (typeof rkey !== "string" || !/^m-[A-Za-z0-9_-]{43}$/.test(rkey)) {
      return fail(400, { action: "removeMember", message: "Invalid member record" });
    }
    try {
      const space = circleUri(owner);
      await deleteSpaceRecord(session, {
        space,
        collection: MEMBER_COLLECTION,
        rkey,
      });
      await provider(session).syncSpace(space, did);
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
