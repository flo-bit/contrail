import { describe, it, expect } from "vitest";
import {
  cidForOp,
  getLastOpCid,
  type SignedGenesisOp,
  type SignedTombstoneOp,
} from "../src/core/community/plc";

const GENESIS_OP: SignedGenesisOp = {
  type: "plc_operation",
  prev: null,
  rotationKeys: ["did:key:zQ3shjNSBChNYuYsW41QDdm2D25zmQkdpfhgbaQBRG4ecg7sk"],
  verificationMethods: {
    atproto: "did:key:zQ3shmefuqey6KqP7M9cwFwywqTVuCZFXcCAGJ5JGktdAUdD2",
  },
  alsoKnownAs: ["at://probe.devnet.test"],
  services: {
    atproto_pds: {
      type: "AtprotoPersonalDataServer",
      endpoint: "https://devnet.test",
    },
  },
  sig: "xEZ7BS7bXJ-7KqExTH158uJFNhcTi21khw-rCHjt70EwGVhftk29Xjf1IR9JGhSmDPE76Xqc01ydF9TmmPHr2w",
};

const TOMBSTONE_OP: SignedTombstoneOp = {
  type: "plc_tombstone",
  prev: "bafyreiabmto3hekxoflemevicopvpud2k6ypf2fkp3v3g6iu36l4wxxfle",
  sig: "abc123",
};

describe("getLastOpCid", () => {
  it("returns the CID computed locally from the PLC log/last op response", async () => {
    let calledUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      calledUrl = String(input);
      return new Response(JSON.stringify(GENESIS_OP), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const cid = await getLastOpCid("https://plc.test", "did:plc:abc", {
      fetch: fakeFetch,
    });
    expect(calledUrl).toBe("https://plc.test/did:plc:abc/log/last");
    // PLC returns the bare op (no envelope). The function must compute the
    // CID with the same DAG-CBOR encoder cidForOp uses so the value matches
    // the CID PLC stored when it accepted the op.
    expect(cid).toBe(await cidForOp(GENESIS_OP));
  });

  it("computes the CID from a tombstone op response too", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify(TOMBSTONE_OP), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const cid = await getLastOpCid("https://plc.test", "did:plc:abc", {
      fetch: fakeFetch,
    });
    expect(cid).toBe(await cidForOp(TOMBSTONE_OP));
  });

  it("strips a trailing slash from the directory base", async () => {
    let calledUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      calledUrl = String(input);
      return new Response(JSON.stringify(GENESIS_OP), { status: 200 });
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
});
