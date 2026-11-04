import {
  getSpace,
  PdsRequestError,
  pdsProcedure,
  pdsQuery,
  putSpaceMember,
  type AuthenticatedPdsSession,
} from "./consumer";
import { formatSpaceUri, parseSpaceRecordUri, parseSpaceUri } from "./uri";

/** The verifier lives in an owner-only control Space, never in the public repo
 * or in the event Space that recipients can read. The usable secret is returned
 * once to the host and belongs in the URL fragment, not a query string. */
export interface SpaceInvitation {
  $type: string;
  space: string;
  subject: { uri: string };
  secretHash: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  recipient?: string;
}
export interface InvitationLink {
  owner: string;
  rkey: string;
  secret: string;
}

export function invitationUrl(origin: string, link: InvitationLink): string {
  const url = new URL(
    `/invite/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.rkey)}`,
    origin,
  );
  if (!secretPattern.test(link.secret))
    throw new TypeError("Invalid invitation secret");
  url.hash = link.secret;
  return url.href;
}

/** Publish this under an application-owned NSID; applications sharing that
 * definition can exchange the same PDS records without sharing OAuth tokens. */
export function invitationLexicon(collection: string): object {
  return {
    lexicon: 1,
    id: collection,
    defs: {
      main: {
        type: "record",
        key: "any",
        record: {
          type: "object",
          required: ["space", "subject", "secretHash", "createdAt"],
          properties: {
            space: { type: "string", format: "space-ref" },
            subject: {
              type: "object",
              required: ["uri"],
              properties: { uri: { type: "string", format: "at-uri" } },
            },
            secretHash: { type: "string", minLength: 43, maxLength: 43 },
            createdAt: { type: "string", format: "datetime" },
            expiresAt: { type: "string", format: "datetime" },
            revokedAt: { type: "string", format: "datetime" },
            recipient: { type: "string", format: "did" },
          },
        },
      },
    },
  };
}
export interface InvitationTarget {
  space: string;
  uri: string;
  collection: string;
}
export class InvitationError extends Error {
  constructor(
    readonly code: "InvalidInvitation" | "OwnerUnavailable" | "WrongRecipient",
  ) {
    super(
      code === "OwnerUnavailable"
        ? "The host needs to reconnect their account."
        : code === "WrongRecipient"
          ? "This invitation is for another account."
          : "This invitation is unavailable.",
    );
    this.name = "InvitationError";
  }
}
export interface SpaceInvitationsOptions<T> {
  controlSpaceType: string;
  invitationCollection: string;
  /** Only these Space types/collections can be previewed or joined. */
  targets: Readonly<Record<string, readonly string[]>>;
  /** The application owns OAuth custody and refresh coordination. Never expose
   * this client, its tokens, or raw control records to the recipient. */
  restoreOwnerSession(did: string): Promise<AuthenticatedPdsSession>;
  /** Trusted in-process read. Return only the selected record's safe preview;
   * no references, guest lists, relation counts, or credentials. */
  preview(target: InvitationTarget, owner: AuthenticatedPdsSession): Promise<T>;
  now?: () => number;
}
const controlKey = "self";
const privatePolicy = "com.atproto.personalspace.policy";
const didPattern = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const rkeyPattern = /^[A-Za-z0-9._~:-]{1,128}$/;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
async function hash(secret: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    ),
  );
}
function equal(left: string, right: string): boolean {
  let different = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return different === 0;
}

export function createSpaceInvitations<T>(options: SpaceInvitationsOptions<T>) {
  const now = options.now ?? Date.now;
  const controlSpace = (owner: string) =>
    formatSpaceUri({
      authorityDid: owner,
      type: options.controlSpaceType,
      skey: controlKey,
    });
  function target(
    owner: string,
    record: Pick<SpaceInvitation, "space" | "subject">,
  ): InvitationTarget {
    const space = parseSpaceUri(record.space);
    const subject = parseSpaceRecordUri(record.subject.uri);
    if (
      space.authorityDid !== owner ||
      subject.writerDid !== owner ||
      subject.spaceUri !== space.uri ||
      !options.targets[space.type]?.includes(subject.collection)
    ) {
      throw new InvitationError("InvalidInvitation");
    }
    return {
      space: space.uri,
      uri: subject.uri,
      collection: subject.collection,
    };
  }
  async function ownerSession(did: string) {
    if (!didPattern.test(did)) throw new InvitationError("InvalidInvitation");
    let session: AuthenticatedPdsSession;
    try {
      session = await options.restoreOwnerSession(did);
    } catch {
      throw new InvitationError("OwnerUnavailable");
    }
    if (session.did !== did) throw new InvitationError("OwnerUnavailable");
    return session;
  }
  async function assertPrivateControl(
    session: AuthenticatedPdsSession,
    create: boolean,
  ) {
    const space = controlSpace(session.did);
    if (create) {
      // createSpace has no upsert. Ignore only its explicit AlreadyExists error.
      const response = await session.handle(
        "/xrpc/com.atproto.space.createSpace",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            spaceType: options.controlSpaceType,
            skey: controlKey,
            policy: { $type: privatePolicy },
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        if (body.error !== "SpaceAlreadyExists")
          throw new InvitationError("OwnerUnavailable");
      }
    }
    const description = await getSpace(session, space);
    if (
      description.uri !== space ||
      description.policy?.$type !== privatePolicy
    ) {
      throw new InvitationError("InvalidInvitation");
    }
    return space;
  }
  async function load(link: InvitationLink, session: AuthenticatedPdsSession) {
    if (!rkeyPattern.test(link.rkey) || !secretPattern.test(link.secret))
      throw new InvitationError("InvalidInvitation");
    const control = await assertPrivateControl(session, false);
    const result = await pdsQuery<{ value: SpaceInvitation; cid: string }>(
      session,
      "com.atproto.space.getRecord",
      {
        space: control,
        repo: session.did,
        collection: options.invitationCollection,
        rkey: link.rkey,
      },
    );
    const record = result.value;
    if (
      record.$type !== options.invitationCollection ||
      record.revokedAt ||
      typeof record.secretHash !== "string" ||
      !equal(record.secretHash, await hash(link.secret)) ||
      (record.expiresAt !== undefined &&
        (!Number.isFinite(Date.parse(record.expiresAt)) ||
          Date.parse(record.expiresAt) <= now()))
    ) {
      throw new InvitationError("InvalidInvitation");
    }
    return {
      record,
      target: target(session.did, record),
      control,
      cid: result.cid,
    };
  }
  async function grantMember(
    session: AuthenticatedPdsSession,
    space: string,
    did: string,
  ) {
    try {
      await putSpaceMember(session, space, did, { read: true, write: true });
    } catch (error) {
      // Invitations grant native membership; never convert the target policy.
      if (error instanceof PdsRequestError && error.code === "PolicyMismatch") {
        throw new InvitationError("InvalidInvitation");
      }
      throw error;
    }
  }
  return {
    controlSpace,
    async addMember(
      session: AuthenticatedPdsSession,
      input: { space: string; did: string },
    ): Promise<void> {
      const parsed = parseSpaceUri(input.space);
      if (
        parsed.authorityDid !== session.did ||
        !options.targets[parsed.type] ||
        !didPattern.test(input.did)
      ) {
        throw new TypeError("Invalid membership target");
      }
      await grantMember(session, parsed.uri, input.did);
    },
    async create(
      session: AuthenticatedPdsSession,
      input: {
        space: string;
        uri: string;
        expiresAt?: string;
        recipient?: string;
      },
    ): Promise<InvitationLink> {
      target(session.did, { space: input.space, subject: { uri: input.uri } });
      if (
        input.expiresAt !== undefined &&
        (!Number.isFinite(Date.parse(input.expiresAt)) ||
          Date.parse(input.expiresAt) <= now())
      ) {
        throw new TypeError("Invitation expiry must be in the future");
      }
      if (input.recipient && !didPattern.test(input.recipient))
        throw new TypeError("Invalid recipient DID");
      const control = await assertPrivateControl(session, true);
      const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const rkey = crypto.randomUUID();
      const record: SpaceInvitation = {
        $type: options.invitationCollection,
        space: input.space,
        subject: { uri: input.uri },
        secretHash: await hash(secret),
        createdAt: new Date(now()).toISOString(),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        ...(input.recipient ? { recipient: input.recipient } : {}),
      };
      await pdsProcedure(session, "com.atproto.space.putRecord", {
        space: control,
        repo: session.did,
        collection: options.invitationCollection,
        rkey,
        record,
      });
      return { owner: session.did, rkey, secret };
    },
    async preview(link: InvitationLink): Promise<T> {
      const session = await ownerSession(link.owner);
      const invitation = await load(link, session);
      return options.preview(invitation.target, session);
    },
    async accept(
      viewer: AuthenticatedPdsSession,
      link: InvitationLink,
    ): Promise<InvitationTarget> {
      if (!didPattern.test(viewer.did))
        throw new TypeError("An authenticated guest is required");
      const session = await ownerSession(link.owner);
      const invitation = await load(link, session);
      if (
        invitation.record.recipient &&
        invitation.record.recipient !== viewer.did
      )
        throw new InvitationError("WrongRecipient");
      // The PDS, not a local projection, remains authoritative for membership.
      // Membership is idempotent; RSVP is a separate guest-owned write.
      if (viewer.did !== session.did) {
        await grantMember(session, invitation.target.space, viewer.did);
      }
      return invitation.target;
    },
    async revoke(
      session: AuthenticatedPdsSession,
      rkey: string,
    ): Promise<void> {
      if (!rkeyPattern.test(rkey))
        throw new TypeError("Invalid invitation key");
      const control = await assertPrivateControl(session, false);
      // Deleting the definition invalidates the link; it does not eject members
      // who previously accepted. Removing those members is an explicit action.
      await pdsProcedure(session, "com.atproto.space.deleteRecord", {
        space: control,
        repo: session.did,
        collection: options.invitationCollection,
        rkey,
      });
    },
  };
}
