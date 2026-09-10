import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject
} from "node:crypto";
import type { ProviderCredentialContext } from "./types.js";

const FORMAT_PREFIX = Buffer.from("EP1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class ProviderSecretCipher {
  private constructor(private readonly key: KeyObject) {}

  static fromEncodedKey(encodedKey: string): ProviderSecretCipher {
    const keyBytes = decodeMasterKey(encodedKey);
    try {
      return new ProviderSecretCipher(createSecretKey(keyBytes));
    } finally {
      keyBytes.fill(0);
    }
  }

  encrypt(secret: string, context: ProviderCredentialContext): Buffer {
    if (!secret || secret.length > 512 || secret.trim() !== secret) {
      throw new Error("Provider API key must contain 1 to 512 non-edge-whitespace characters");
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([FORMAT_PREFIX, iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer, context: ProviderCredentialContext): string {
    const minimumLength = FORMAT_PREFIX.length + IV_BYTES + TAG_BYTES + 1;
    if (payload.length < minimumLength || !payload.subarray(0, FORMAT_PREFIX.length).equals(FORMAT_PREFIX)) {
      throw new Error("Stored provider credential is invalid");
    }
    try {
      const ivStart = FORMAT_PREFIX.length;
      const tagStart = ivStart + IV_BYTES;
      const ciphertextStart = tagStart + TAG_BYTES;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        payload.subarray(ivStart, tagStart)
      );
      decipher.setAAD(aad(context));
      decipher.setAuthTag(payload.subarray(tagStart, ciphertextStart));
      const plaintext = Buffer.concat([
        decipher.update(payload.subarray(ciphertextStart)),
        decipher.final()
      ]).toString("utf8");
      if (!plaintext || plaintext.length > 512) throw new Error("invalid plaintext");
      return plaintext;
    } catch {
      throw new Error("Stored provider credential could not be decrypted");
    }
  }
}

export function providerSecretCipherFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): ProviderSecretCipher {
  const encodedKey = environment.PROVIDER_MASTER_KEY;
  if (!encodedKey) throw new Error("PROVIDER_MASTER_KEY is required for energy providers");
  return ProviderSecretCipher.fromEncodedKey(encodedKey);
}

function decodeMasterKey(value: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("PROVIDER_MASTER_KEY must be 32 bytes encoded as 64 hex characters or base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) {
    bytes.fill(0);
    throw new Error("PROVIDER_MASTER_KEY must decode to exactly 32 bytes");
  }
  return bytes;
}

function aad(context: ProviderCredentialContext): Buffer {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(context.providerType)) {
    throw new Error("Invalid provider type");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.credentialId)) {
    throw new Error("Invalid provider credential id");
  }
  if (!Number.isSafeInteger(context.version) || context.version < 1) {
    throw new Error("Invalid provider credential version");
  }
  return Buffer.from(
    `tron-seamless/energy-provider/v1/${context.providerType}/${context.credentialId.toLowerCase()}/${context.version}`,
    "utf8"
  );
}
