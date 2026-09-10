import { createHash } from "node:crypto";
import { computeAddress, SigningKey } from "ethers";
import { describe, expect, it } from "vitest";
import { GatewayError, ReturnCode } from "../src/domain.js";
import { inspectSignedTransaction } from "../src/grpc/transaction-inspector.js";
import { protocolTypes } from "../src/grpc/protocol.js";
import { tronHexToBase58 } from "../src/tron-address.js";

// Deterministic public test fixture. Never use this derived key for real funds.
const PRIVATE_KEY = `0x${createHash("sha256").update("tron-seamless-public-test-fixture").digest("hex")}`;

describe("signed transaction inspection", () => {
  it("extracts policy fields and verifies the owner signature", () => {
    const ethereum = computeAddress(PRIVATE_KEY);
    const ownerBytes = Buffer.from(`41${ethereum.slice(2)}`, "hex");
    const contractBytes = Buffer.from("41" + "11".repeat(20), "hex");
    const trigger = protocolTypes.triggerType.create({
      ownerAddress: ownerBytes,
      contractAddress: contractBytes,
      data: Buffer.from("a9059cbb" + "00".repeat(64), "hex")
    });
    const triggerBytes = protocolTypes.triggerType.encode(trigger).finish();
    const now = Date.now();
    const raw = protocolTypes.transactionRawType.create({
      refBlockBytes: Buffer.from("1234", "hex"),
      refBlockHash: Buffer.from("0102030405060708", "hex"),
      expiration: now + 60_000,
      timestamp: now,
      feeLimit: 100_000_000,
      contract: [
        {
          type: 31,
          parameter: {
            typeUrl: "type.googleapis.com/protocol.TriggerSmartContract",
            value: triggerBytes
          }
        }
      ]
    });
    const rawBytes = Buffer.from(protocolTypes.transactionRawType.encode(raw).finish());
    const txId = createHash("sha256").update(rawBytes).digest("hex");
    const signature = Buffer.from(new SigningKey(PRIVATE_KEY).sign(`0x${txId}`).serialized.slice(2), "hex");
    const transaction = protocolTypes.transactionType.create({ rawData: raw, signature: [signature] });
    const transactionBytes = Buffer.from(protocolTypes.transactionType.encode(transaction).finish());

    const inspected = inspectSignedTransaction(transactionBytes);
    expect(inspected.txId).toBe(txId);
    expect(inspected.ownerAddress).toBe(tronHexToBase58(ownerBytes));
    expect(inspected.contractAddress).toBe(tronHexToBase58(contractBytes));
    expect(inspected.functionSelector).toBe("a9059cbb");
    expect(inspected.feeLimitSun).toBe(100_000_000n);
    expect(inspected.refBlockBytes.toString("hex")).toBe("1234");
    expect(inspected.refBlockHash.toString("hex")).toBe("0102030405060708");
    expect(inspected.memoLength).toBe(0);
    expect(inspected.signatures).toHaveLength(1);
  });

  it("rejects a signature that does not authorize owner_address", () => {
    const ownerBytes = Buffer.from("41" + "22".repeat(20), "hex");
    const contractBytes = Buffer.from("41" + "11".repeat(20), "hex");
    const triggerBytes = protocolTypes.triggerType.encode(
      protocolTypes.triggerType.create({
        ownerAddress: ownerBytes,
        contractAddress: contractBytes,
        data: Buffer.from("a9059cbb", "hex")
      })
    ).finish();
    const raw = protocolTypes.transactionRawType.create({
      refBlockBytes: Buffer.from("1234", "hex"),
      refBlockHash: Buffer.from("0102030405060708", "hex"),
      expiration: Date.now() + 60_000,
      timestamp: Date.now(),
      contract: [{
        type: 31,
        parameter: {
          typeUrl: "type.googleapis.com/protocol.TriggerSmartContract",
          value: triggerBytes
        }
      }]
    });
    const rawBytes = Buffer.from(protocolTypes.transactionRawType.encode(raw).finish());
    const txId = createHash("sha256").update(rawBytes).digest("hex");
    const signature = Buffer.from(new SigningKey(PRIVATE_KEY).sign(`0x${txId}`).serialized.slice(2), "hex");
    const encoded = Buffer.from(
      protocolTypes.transactionType.encode(protocolTypes.transactionType.create({ rawData: raw, signature: [signature] })).finish()
    );
    expect(() => inspectSignedTransaction(encoded)).toThrow(/does not authorize/);
  });

  it("rejects an Any type URL that does not match the declared contract type", () => {
    const ethereum = computeAddress(PRIVATE_KEY);
    const ownerBytes = Buffer.from(`41${ethereum.slice(2)}`, "hex");
    const triggerBytes = protocolTypes.triggerType.encode(
      protocolTypes.triggerType.create({
        ownerAddress: ownerBytes,
        contractAddress: Buffer.from("41" + "11".repeat(20), "hex"),
        data: Buffer.from("a9059cbb" + "00".repeat(64), "hex")
      })
    ).finish();
    const raw = protocolTypes.transactionRawType.create({
      refBlockBytes: Buffer.from("1234", "hex"),
      refBlockHash: Buffer.from("0102030405060708", "hex"),
      expiration: Date.now() + 60_000,
      timestamp: Date.now(),
      contract: [{
        type: 31,
        parameter: {
          typeUrl: "type.googleapis.com/protocol.TransferContract",
          value: triggerBytes
        }
      }]
    });
    const rawBytes = Buffer.from(protocolTypes.transactionRawType.encode(raw).finish());
    const txId = createHash("sha256").update(rawBytes).digest("hex");
    const signature = Buffer.from(
      new SigningKey(PRIVATE_KEY).sign(`0x${txId}`).serialized.slice(2),
      "hex"
    );
    const encoded = Buffer.from(protocolTypes.transactionType.encode(
      protocolTypes.transactionType.create({ rawData: raw, signature: [signature] })
    ).finish());

    expect(() => inspectSignedTransaction(encoded)).toThrow(/parameter type/);
  });

  it("rejects a transaction containing pre-execution results", () => {
    const ethereum = computeAddress(PRIVATE_KEY);
    const ownerBytes = Buffer.from(`41${ethereum.slice(2)}`, "hex");
    const triggerBytes = protocolTypes.triggerType.encode(
      protocolTypes.triggerType.create({
        ownerAddress: ownerBytes,
        contractAddress: Buffer.from("41" + "11".repeat(20), "hex"),
        data: Buffer.from("a9059cbb" + "00".repeat(64), "hex")
      })
    ).finish();
    const raw = protocolTypes.transactionRawType.create({
      refBlockBytes: Buffer.from("1234", "hex"),
      refBlockHash: Buffer.from("0102030405060708", "hex"),
      expiration: Date.now() + 60_000,
      timestamp: Date.now(),
      contract: [{
        type: 31,
        parameter: {
          typeUrl: "type.googleapis.com/protocol.TriggerSmartContract",
          value: triggerBytes
        }
      }]
    });
    const rawBytes = Buffer.from(protocolTypes.transactionRawType.encode(raw).finish());
    const txId = createHash("sha256").update(rawBytes).digest("hex");
    const signature = Buffer.from(
      new SigningKey(PRIVATE_KEY).sign(`0x${txId}`).serialized.slice(2),
      "hex"
    );
    const encoded = Buffer.from(protocolTypes.transactionType.encode(
      protocolTypes.transactionType.create({ rawData: raw, signature: [signature], ret: [{}] })
    ).finish());

    expectGatewayError(encoded, ReturnCode.CONTRACT_VALIDATE_ERROR, "TRANSACTION_RET_NOT_EMPTY");
  });

  it("reserves 128 bytes below java-tron's 500 KiB transaction limit", () => {
    const encoded = Buffer.alloc(500 * 1024 - 128 + 1);

    expectGatewayError(encoded, ReturnCode.TOO_BIG_TRANSACTION_ERROR, "TOO_BIG_TRANSACTION_ERROR");
  });

  it("rejects raw_data bytes that java-tron would canonicalize before signature validation", () => {
    const ethereum = computeAddress(PRIVATE_KEY);
    const ownerBytes = Buffer.from(`41${ethereum.slice(2)}`, "hex");
    const triggerBytes = protocolTypes.triggerType.encode(
      protocolTypes.triggerType.create({
        ownerAddress: ownerBytes,
        contractAddress: Buffer.from("41" + "11".repeat(20), "hex"),
        data: Buffer.from("a9059cbb" + "00".repeat(64), "hex")
      })
    ).finish();
    const raw = protocolTypes.transactionRawType.create({
      refBlockBytes: Buffer.from("1234", "hex"),
      refBlockHash: Buffer.from("0102030405060708", "hex"),
      expiration: Date.now() + 60_000,
      timestamp: Date.now(),
      feeLimit: 100_000_000,
      contract: [{
        type: 31,
        parameter: {
          typeUrl: "type.googleapis.com/protocol.TriggerSmartContract",
          value: triggerBytes
        }
      }]
    });
    const canonicalRaw = Buffer.from(protocolTypes.transactionRawType.encode(raw).finish());
    // Field 3 (ref_block_num) explicitly encoded as its default value. The
    // protobuf parser accepts it, but java-tron drops it when serializing
    // getRawData() for txID/signature verification.
    const nonCanonicalRaw = Buffer.concat([canonicalRaw, Buffer.from([0x18, 0x00])]);
    const nonCanonicalTxId = createHash("sha256").update(nonCanonicalRaw).digest("hex");
    const signature = Buffer.from(
      new SigningKey(PRIVATE_KEY).sign(`0x${nonCanonicalTxId}`).serialized.slice(2),
      "hex"
    );
    const encoded = encodeTransactionWire(nonCanonicalRaw, signature);

    expectGatewayError(encoded, ReturnCode.SIGERROR, "NON_CANONICAL_RAW_DATA");
  });

  it("rejects a contract parameter that TRON peers would canonicalize", () => {
    const ethereum = computeAddress(PRIVATE_KEY);
    const ownerBytes = Buffer.from(`41${ethereum.slice(2)}`, "hex");
    const canonicalTrigger = Buffer.from(protocolTypes.triggerType.encode(
      protocolTypes.triggerType.create({
        ownerAddress: ownerBytes,
        contractAddress: Buffer.from("41" + "11".repeat(20), "hex"),
        data: Buffer.from("a9059cbb" + "00".repeat(64), "hex")
      })
    ).finish());
    // TriggerSmartContract field 3 (call_value) explicitly encoded as zero.
    const nonCanonicalTrigger = Buffer.concat([canonicalTrigger, Buffer.from([0x18, 0x00])]);
    const raw = protocolTypes.transactionRawType.create({
      refBlockBytes: Buffer.from("1234", "hex"),
      refBlockHash: Buffer.from("0102030405060708", "hex"),
      expiration: Date.now() + 60_000,
      timestamp: Date.now(),
      feeLimit: 100_000_000,
      contract: [{
        type: 31,
        parameter: {
          typeUrl: "type.googleapis.com/protocol.TriggerSmartContract",
          value: nonCanonicalTrigger
        }
      }]
    });
    const rawBytes = Buffer.from(protocolTypes.transactionRawType.encode(raw).finish());
    const txId = createHash("sha256").update(rawBytes).digest("hex");
    const signature = Buffer.from(
      new SigningKey(PRIVATE_KEY).sign(`0x${txId}`).serialized.slice(2),
      "hex"
    );
    const transaction = protocolTypes.transactionType.create({ rawData: raw, signature: [signature] });
    const encoded = Buffer.from(protocolTypes.transactionType.encode(transaction).finish());

    expectGatewayError(
      encoded,
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "NON_CANONICAL_CONTRACT_PARAMETER"
    );
  });
});

function expectGatewayError(transactionBytes: Buffer, returnCode: number, internalCode: string): void {
  try {
    inspectSignedTransaction(transactionBytes);
    throw new Error("Expected inspectSignedTransaction to reject the transaction");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ returnCode, internalCode });
  }
}

function encodeTransactionWire(rawData: Buffer, signature: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x0a]),
    encodeVarint(rawData.length),
    rawData,
    Buffer.from([0x12]),
    encodeVarint(signature.length),
    signature
  ]);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}
