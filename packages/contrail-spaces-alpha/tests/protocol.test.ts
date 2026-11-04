import { P256Keypair } from "@atproto/crypto";
import {
  COMMIT_MAC_TYPE,
  formatMacHeader,
  verifyCredentialSig,
} from "@atproto/space";
import { describe, expect, it } from "vitest";
import {
  exchangeSpaceCredential,
  getRepoStar,
  SpaceCredentialTransport,
  SpaceIdentityResolver,
  SpaceProtocolError,
} from "../src/protocol";

const space = "at://did:plc:alice/space/garden.atmo.circle/self";
const macHeaders = {
  "Atproto-Space-Mac": formatMacHeader(COMMIT_MAC_TYPE, new Uint8Array(32)),
};
const jwt = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("Spaces alpha transport", () => {
  it.each([
    "SpaceNotFound",
    "UserNotAuthorized",
    "NotAuthorized",
    "AppNotAuthorized",
  ])(
    "keeps authorization refusals ambiguous and non-destructive: %s",
    async (code) => {
      let requests = 0;
      await expect(
        exchangeSpaceCredential({
          authorityPds: "https://pds.example",
          delegationToken: "delegation",
          spaceUri: space,
          fetch: async () => {
            requests++;
            return Response.json({ error: code }, { status: 400 });
          },
        }),
      ).rejects.toMatchObject({ code, accessDenied: true, deleted: false });
      expect(requests).toBe(1);
      expect(new SpaceProtocolError(400, code).deleted).toBe(false);
    },
  );
  it("exchanges assertions in the body and binds a fresh P-256 key", async () => {
    const transport = await exchangeSpaceCredential({
      authorityPds: "https://pds.example",
      delegationToken: "delegation",
      spaceUri: space,
      fetch: async (input) => {
        const request = input as Request;
        expect(request.headers.has("authorization")).toBe(false);
        expect(request.headers.has("dpop")).toBe(false);
        const body = (await request.json()) as {
          credentialKid: string;
          delegationToken: string;
        };
        expect(body.delegationToken).toBe("delegation");
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          credential: `${jwt({ typ: "atproto-space-credential+jwt", kid: "#atproto" })}.${jwt(
            {
              iss: "did:plc:alice",
              sub: space,
              iat: now,
              exp: now + 600,
              jti: "one",
              cnf: { kid: body.credentialKid },
            },
          )}.signature`,
        });
      },
    });
    expect((await transport.serialize()).format).toBe("http-signature-v1");
    const restored = await SpaceCredentialTransport.restore(
      await transport.serialize(),
    );
    expect(restored.key.did()).toBe(transport.key.did());
  });

  it("uses tagged HTTP signatures bound to the exact account audience", async () => {
    const key = await P256Keypair.create({ exportable: true });
    const transport = new SpaceCredentialTransport(
      "credential",
      key,
      Date.now() + 60_000,
      async (input) => {
        const request = input as Request;
        expect(request.redirect).toBe("manual");
        expect(request.headers.get("authorization")).toBe(
          "Atproto-Space-Credential credential",
        );
        expect(request.headers.get("atproto-space-audience")).toBe(
          "did:plc:bob",
        );
        expect(request.headers.has("dpop")).toBe(false);
        await verifyCredentialSig(
          Object.fromEntries(request.headers.entries()),
          key.did() as never,
        );
        return Response.json({});
      },
    );
    await transport.fetch("https://shared.pds/xrpc/example", {}, "did:plc:bob");
  });

  it("resolves the normal PDS, ignoring obsolete space-host services", async () => {
    const resolver = new SpaceIdentityResolver({
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return Response.json({
          id: "did:plc:alice",
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "https://pds.example",
            },
            {
              id: "#atproto_space_host",
              type: "Old",
              serviceEndpoint: "https://obsolete.example",
            },
          ],
        });
      },
    });
    expect(await resolver.resolvePds("did:plc:alice")).toBe(
      "https://pds.example",
    );
  });

  it("rejects stored credentials with a missing format discriminator", async () => {
    await expect(
      SpaceCredentialTransport.restore({ token: "invalid" } as never),
    ).rejects.toMatchObject({ code: "CredentialExpired" });
  });

  it("bounds STAR downloads and cancels oversized streams", async () => {
    const kem = await P256Keypair.create();
    const transport = (response: Response) =>
      ({ fetch: async () => response }) as unknown as SpaceCredentialTransport;
    const result = await getRepoStar(
      transport(new Response(Uint8Array.of(1, 2, 3), { headers: macHeaders })),
      "https://pds.example",
      {
        space,
        repo: "did:plc:alice",
        kemDidKey: kem.did(),
        maxBytes: 3,
      },
    );
    expect([...result.bytes]).toEqual([1, 2, 3]);
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: macHeaders },
    );
    await expect(
      getRepoStar(transport(response), "https://pds.example", {
        space,
        repo: "did:plc:alice",
        kemDidKey: kem.did(),
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: "RepoTooLarge" });
    expect(cancelled).toBe(true);
  });
});
