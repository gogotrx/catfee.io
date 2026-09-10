import bs58check from "bs58check";

const TRON_PREFIX = 0x41;

export function tronHexToBase58(address: Uint8Array): string {
  const bytes = Buffer.from(address);
  if (bytes.length !== 21 || bytes[0] !== TRON_PREFIX) {
    throw new Error("Expected a 21-byte TRON address with 0x41 prefix");
  }
  return bs58check.encode(bytes);
}

export function tronBase58ToHex(address: string): Buffer {
  const decoded = Buffer.from(bs58check.decode(address));
  if (decoded.length !== 21 || decoded[0] !== TRON_PREFIX) {
    throw new Error("Invalid TRON Base58Check address");
  }
  return decoded;
}

export function normalizeTronAddress(address: string): string {
  return tronHexToBase58(tronBase58ToHex(address));
}
