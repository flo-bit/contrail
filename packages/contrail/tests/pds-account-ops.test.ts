import { describe, it, expect } from "vitest";
import {
  pdsGetRecommendedDidCredentials,
  pdsActivateAccount,
} from "../src/core/community/pds";

describe("pdsGetRecommendedDidCredentials", () => {
  it("issues GET to the identity endpoint with bearer accessJwt and parses response", async () => {
    let received: { url: string; init: any } | null = null;
    const fetch = (async (url: string, init: any) => {
      received = { url, init };
      return new Response(
        JSON.stringify({
          rotationKeys: ["did:key:zRot"],
          verificationMethods: { atproto: "did:key:zSig" },
          alsoKnownAs: ["at://h.test"],
          services: {
            atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://pds.test" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await pdsGetRecommendedDidCredentials(
      "https://pds.test",
      "AT",
      { fetch }
    );

    expect(received!.url).toBe(
      "https://pds.test/xrpc/com.atproto.identity.getRecommendedDidCredentials"
    );
    // Default fetch method is GET when none specified.
    expect(received!.init?.method ?? "GET").toBe("GET");
    // Bearer is the session accessJwt, NOT a service-auth JWT.
    expect(received!.init.headers.authorization).toBe("Bearer AT");
    expect(result.rotationKeys).toEqual(["did:key:zRot"]);
    expect(result.verificationMethods).toEqual({ atproto: "did:key:zSig" });
    expect(result.alsoKnownAs).toEqual(["at://h.test"]);
    expect(result.services).toEqual({
      atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://pds.test" },
    });
  });

  it("throws with status and body on non-2xx", async () => {
    const fetch = (async () =>
      new Response("session expired", { status: 401 })) as any;
    await expect(
      pdsGetRecommendedDidCredentials("https://pds.test", "AT", { fetch })
    ).rejects.toThrow(/getRecommendedDidCredentials failed.*401.*session expired/);
  });
});

describe("pdsActivateAccount", () => {
  it("issues POST to activateAccount with bearer accessJwt and resolves to undefined", async () => {
    let received: { url: string; init: any } | null = null;
    const fetch = (async (url: string, init: any) => {
      received = { url, init };
      return new Response("", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await pdsActivateAccount("https://pds.test", "AT", { fetch });

    expect(received!.url).toBe(
      "https://pds.test/xrpc/com.atproto.server.activateAccount"
    );
    expect(received!.init.method).toBe("POST");
    // Bearer is the session accessJwt from pdsCreateAccount, NOT a service-auth JWT.
    expect(received!.init.headers.authorization).toBe("Bearer AT");
    expect(result).toBeUndefined();
  });

  it("throws with status and body on non-2xx", async () => {
    const fetch = (async () =>
      new Response("nope", { status: 400 })) as any;
    await expect(
      pdsActivateAccount("https://pds.test", "AT", { fetch })
    ).rejects.toThrow(/activateAccount failed.*400.*nope/);
  });
});
