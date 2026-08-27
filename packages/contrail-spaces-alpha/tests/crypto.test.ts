import { describe, expect, it } from "vitest";
import {
  decryptJson,
  encryptJson,
  generateCredentialEncryptionKey,
} from "../src/crypto";

describe("credential encryption", () => {
  it("round trips with bound context and rejects another Space", async () => {
    const key = await generateCredentialEncryptionKey();
    const encrypted = await encryptJson({ token: "secret" }, key, "space:a");
    await expect(decryptJson(encrypted, key, "space:a")).resolves.toEqual({ token: "secret" });
    await expect(decryptJson(encrypted, key, "space:b")).rejects.toThrow();
    expect(JSON.stringify(encrypted)).not.toContain("secret");
  });
});
