import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProviderSecretCipher, providerSecretCipherFromEnvironment } from "../src/providers/crypto.js";

describe("ProviderSecretCipher", () => {
  it("encrypts API keys with AES-GCM without retaining plaintext", () => {
    const cipher = ProviderSecretCipher.fromEncodedKey(randomBytes(32).toString("hex"));
    const secret = "kuaizu-api-key-that-must-never-be-visible";
    const context = { providerType: "kuaizu", credentialId: randomUUID(), version: 1 };
    const encrypted = cipher.encrypt(secret, context);

    expect(encrypted.toString("utf8")).not.toContain(secret);
    expect(cipher.decrypt(encrypted, context)).toBe(secret);
    expect(() => cipher.decrypt(encrypted, { ...context, credentialId: randomUUID() })).toThrow(
      /could not be decrypted/
    );
    expect(() => cipher.decrypt(encrypted, { ...context, version: 2 })).toThrow(/could not be decrypted/);
  });

  it("accepts only exact 32-byte hex or canonical base64 master keys", () => {
    const base64 = randomBytes(32).toString("base64");
    expect(providerSecretCipherFromEnvironment({ PROVIDER_MASTER_KEY: base64 })).toBeInstanceOf(
      ProviderSecretCipher
    );
    expect(() => ProviderSecretCipher.fromEncodedKey("too-short")).toThrow(/32 bytes/);
    expect(() => ProviderSecretCipher.fromEncodedKey(`${base64}\n`)).toThrow(/32 bytes/);
  });
});
