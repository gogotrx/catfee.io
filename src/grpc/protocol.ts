import path from "node:path";
import protobuf from "protobufjs";
import { decodeUnaryGrpcFrame, encodeUnaryGrpcFrame } from "./framing.js";

const root = protobuf.loadSync(path.resolve(process.cwd(), "proto", "tron-minimal.proto"));
const transactionType = root.lookupType("protocol.Transaction");
const transactionRawType = root.lookupType("protocol.Transaction.Raw");
const triggerType = root.lookupType("protocol.TriggerSmartContract");
const transferType = root.lookupType("protocol.TransferContract");
const returnType = root.lookupType("protocol.Return");

export function decodeTransaction(payload: Uint8Array): protobuf.Message<Record<string, unknown>> {
  return transactionType.decode(payload) as protobuf.Message<Record<string, unknown>>;
}

export function canonicalTransactionRawBytes(payload: Uint8Array): Buffer {
  const decoded = transactionRawType.decode(payload);
  return Buffer.from(transactionRawType.encode(decoded).finish());
}

export function decodeTriggerSmartContract(payload: Uint8Array): protobuf.Message<Record<string, unknown>> {
  return triggerType.decode(payload) as protobuf.Message<Record<string, unknown>>;
}

export function canonicalTriggerSmartContractBytes(payload: Uint8Array): Buffer {
  const decoded = triggerType.decode(payload);
  return Buffer.from(triggerType.encode(decoded).finish());
}

export function decodeTransferContract(payload: Uint8Array): protobuf.Message<Record<string, unknown>> {
  return transferType.decode(payload) as protobuf.Message<Record<string, unknown>>;
}

export function canonicalTransferContractBytes(payload: Uint8Array): Buffer {
  const decoded = transferType.decode(payload);
  return Buffer.from(transferType.encode(decoded).finish());
}

export function encodeReturnFrame(result: boolean, code: number, message: string): Buffer {
  const value = returnType.create({ result, code, message: Buffer.from(message, "utf8") });
  return encodeUnaryGrpcFrame(returnType.encode(value).finish());
}

export function decodeReturnFrame(frame: Buffer): { result: boolean; code: number; message: string } {
  const decodedFrame = decodeUnaryGrpcFrame(frame);
  if (decodedFrame.compressed) throw new Error("Compressed Return messages are not supported");
  const value = returnType.decode(decodedFrame.payload) as unknown as {
    result?: boolean;
    code?: number;
    message?: Uint8Array;
  };
  return {
    result: value.result ?? false,
    code: value.code ?? 0,
    message: value.message ? Buffer.from(value.message).toString("utf8") : ""
  };
}

export const protocolTypes = {
  transactionType,
  transactionRawType,
  triggerType,
  transferType,
  returnType
};
