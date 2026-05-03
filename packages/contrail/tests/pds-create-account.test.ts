import { describe, it, expect } from "vitest";
import { pdsCreateAccount } from "../src/core/community/pds";

describe("pdsCreateAccount", () => {
  it("posts createAccount with bearer auth and returns session", async () => {
    let received: { url: string; init: any } | null = null;
    const fetch = (async (url: string, init: any) => {
      received = { url, init };
      return new Response(
        JSON.stringify({
          accessJwt: "AT", refreshJwt: "RT", handle: "h.test", did: "did:plc:x",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await pdsCreateAccount(
      "https://pds.test",
      "JWT-VALUE",
      {
        handle: "h.test",
        did: "did:plc:x",
        email: "h@x.test",
        password: "p",
        inviteCode: "code",
      },
      { fetch }
    );

    expect(received!.url).toBe("https://pds.test/xrpc/com.atproto.server.createAccount");
    expect(received!.init.method).toBe("POST");
    expect(received!.init.headers.authorization).toBe("Bearer JWT-VALUE");
    expect(JSON.parse(received!.init.body)).toEqual({
      handle: "h.test",
      did: "did:plc:x",
      email: "h@x.test",
      password: "p",
      inviteCode: "code",
    });
    expect(result.accessJwt).toBe("AT");
    expect(result.did).toBe("did:plc:x");
  });

  it("strips trailing slash from pdsEndpoint", async () => {
    let receivedUrl = "";
    const fetch = (async (url: string) => {
      receivedUrl = url;
      return new Response(
        JSON.stringify({ accessJwt: "AT", refreshJwt: "RT", handle: "h", did: "did:plc:x" }),
        { status: 200 }
      );
    }) as any;
    await pdsCreateAccount(
      "https://pds.test/",
      "JWT",
      { handle: "h", did: "did:plc:x", email: "e", password: "p" },
      { fetch }
    );
    expect(receivedUrl).toBe("https://pds.test/xrpc/com.atproto.server.createAccount");
  });

  it("throws on non-2xx", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: "InvalidRequest", message: "bad" }), { status: 400 })) as any;
    await expect(
      pdsCreateAccount(
        "https://pds.test",
        "x",
        { handle: "h", did: "did:plc:x", email: "e", password: "p" },
        { fetch }
      )
    ).rejects.toThrow(/createAccount failed.*400.*InvalidRequest/);
  });
});
