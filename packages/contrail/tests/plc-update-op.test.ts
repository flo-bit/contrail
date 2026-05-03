import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  buildGenesisOp,
  signGenesisOp,
  buildUpdateOp,
  signUpdateOp,
  cidForOp,
} from "../src/core/community/plc";

describe("cidForOp", () => {
  it("produces a CIDv1 dag-cbor sha256 base32-lower CID starting with bafyrei", async () => {
    const kp = await generateKeyPair();
    const unsigned = buildGenesisOp({
      rotationKeys: [kp.publicDidKey],
      verificationMethodAtproto: kp.publicDidKey,
      alsoKnownAs: ["at://x.test"],
      services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://x.test" } },
    });
    const signed = await signGenesisOp(unsigned, kp.privateJwk);
    const cid = await cidForOp(signed);
    expect(cid).toMatch(/^bafyrei/);
    expect(cid.length).toBeGreaterThan(50);
  });
});

describe("buildUpdateOp + signUpdateOp", () => {
  it("produces a plc_operation with prev set and a sig segment", async () => {
    const kp = await generateKeyPair();
    const genesis = buildGenesisOp({
      rotationKeys: [kp.publicDidKey],
      verificationMethodAtproto: kp.publicDidKey,
      alsoKnownAs: ["at://x.test"],
      services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://x.test" } },
    });
    const signedGenesis = await signGenesisOp(genesis, kp.privateJwk);
    const prev = await cidForOp(signedGenesis);

    const update = buildUpdateOp({
      prev,
      rotationKeys: [kp.publicDidKey, "did:key:zPdsRot"],
      verificationMethodAtproto: "did:key:zPdsSig",
      alsoKnownAs: ["at://x.test"],
      services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://x.test" } },
    });
    expect(update.type).toBe("plc_operation");
    expect(update.prev).toBe(prev);

    const signedUpdate = await signUpdateOp(update, kp.privateJwk);
    expect(signedUpdate.sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
