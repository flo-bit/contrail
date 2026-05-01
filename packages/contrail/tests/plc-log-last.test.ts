import { describe, it, expect } from "vitest";
import { getLastOpCid } from "../src/core/community/plc";

describe("getLastOpCid", () => {
  it("returns the cid from the PLC log/last response body", async () => {
    let calledUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ cid: "bafyreigenesiscid" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const cid = await getLastOpCid("https://plc.test", "did:plc:abc", {
      fetch: fakeFetch,
    });
    expect(cid).toBe("bafyreigenesiscid");
    expect(calledUrl).toBe("https://plc.test/did:plc:abc/log/last");
  });

  it("strips a trailing slash from the directory base", async () => {
    let calledUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ cid: "bafyreitestcid" }), {
        status: 200,
      });
    };
    await getLastOpCid("https://plc.test/", "did:plc:xyz", { fetch: fakeFetch });
    expect(calledUrl).toBe("https://plc.test/did:plc:xyz/log/last");
  });

  it("throws on a non-200 response, including the status and body", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("not found", { status: 404 });
    await expect(
      getLastOpCid("https://plc.test", "did:plc:missing", { fetch: fakeFetch })
    ).rejects.toThrow(/404.*not found/);
  });

  it("throws when the response body has no cid field", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ operation: {} }), { status: 200 });
    await expect(
      getLastOpCid("https://plc.test", "did:plc:abc", { fetch: fakeFetch })
    ).rejects.toThrow(/missing cid/);
  });
});
