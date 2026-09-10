import { createHash } from "node:crypto";
import { Signature, recoverAddress } from "ethers";
import { ContractType, GatewayError, ReturnCode, type InspectedTransaction } from "../domain.js";
import { tronHexToBase58 } from "../tron-address.js";
import { extractLengthDelimitedField } from "./framing.js";
import {
  canonicalTransferContractBytes,
  canonicalTransactionRawBytes,
  canonicalTriggerSmartContractBytes,
  decodeTransaction,
  decodeTransferContract,
  decodeTriggerSmartContract
} from "./protocol.js";

type ProtoBytes = Uint8Array | Buffer;

type DecodedAny = {
  typeUrl?: string;
  type_url?: string;
  value?: ProtoBytes;
};

type DecodedContract = {
  type?: number;
  parameter?: DecodedAny;
  permissionId?: number;
  PermissionId?: number;
};

type DecodedRaw = {
  refBlockBytes?: ProtoBytes;
  refBlockHash?: ProtoBytes;
  expiration?: number | string | bigint | { toString(): string };
  timestamp?: number | string | bigint | { toString(): string };
  feeLimit?: number | string | bigint | { toString(): string };
  data?: ProtoBytes;
  contract?: DecodedContract[];
};

type DecodedTransaction = {
  rawData?: DecodedRaw;
  signature?: ProtoBytes[];
  ret?: unknown[];
};

type DecodedTrigger = {
  ownerAddress?: ProtoBytes;
  contractAddress?: ProtoBytes;
  callValue?: number | string | bigint | { toString(): string };
  data?: ProtoBytes;
  callTokenValue?: number | string | bigint | { toString(): string };
  tokenId?: number | string | bigint | { toString(): string };
};

type DecodedTransfer = {
  ownerAddress?: ProtoBytes;
};

export function inspectSignedTransaction(transactionBytes: Buffer): InspectedTransaction {
  if (transactionBytes.length + 128 > 500 * 1024) {
    throw new GatewayError(
      ReturnCode.TOO_BIG_TRANSACTION_ERROR,
      "Transaction exceeds the conservative java-tron size limit",
      "TOO_BIG_TRANSACTION_ERROR"
    );
  }
  const decoded = decodeTransaction(transactionBytes) as unknown as DecodedTransaction;
  if ((decoded.ret?.length ?? 0) !== 0) {
    throw new GatewayError(
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "Pre-executed transaction results are not accepted for broadcast",
      "TRANSACTION_RET_NOT_EMPTY"
    );
  }
  const rawDataBytes = extractLengthDelimitedField(transactionBytes, 1);
  if (!canonicalTransactionRawBytes(rawDataBytes).equals(rawDataBytes)) {
    throw new GatewayError(
      ReturnCode.SIGERROR,
      "Transaction raw_data is not in java-tron's canonical protobuf form",
      "NON_CANONICAL_RAW_DATA"
    );
  }
  const raw = decoded.rawData;
  const contracts = raw?.contract ?? [];
  const signatures = (decoded.signature ?? []).map((value) => Buffer.from(value));

  if (!raw || contracts.length !== 1) {
    throw validationError("Exactly one transaction contract is required", "INVALID_CONTRACT_COUNT");
  }
  if (signatures.length !== 1) {
    throw validationError("Only one fully-signed signature is supported in this release", "UNSUPPORTED_SIGNATURE_COUNT");
  }

  const refBlockBytes = Buffer.from(raw.refBlockBytes ?? []);
  const refBlockHash = Buffer.from(raw.refBlockHash ?? []);
  if (refBlockBytes.length !== 2 || refBlockHash.length !== 8) {
    throw new GatewayError(
      ReturnCode.TAPOS_ERROR,
      "Transaction TAPOS reference is missing or malformed",
      "INVALID_TAPOS_REFERENCE"
    );
  }
  const memoLength = Buffer.from(raw.data ?? []).length;

  const contract = contracts[0];
  if (!contract || !contract.parameter?.value) {
    throw validationError("Transaction contract parameter is missing", "MISSING_CONTRACT_PARAMETER");
  }

  const contractType = contract.type ?? -1;
  const parameter = Buffer.from(contract.parameter.value);
  const parameterTypeUrl = contract.parameter.typeUrl ?? contract.parameter.type_url;
  const permissionId = contract.permissionId ?? contract.PermissionId ?? 0;
  if (permissionId !== 0) {
    throw validationError("Active-permission and multisig user transactions are not supported yet", "UNSUPPORTED_PERMISSION");
  }

  let ownerBytes: Buffer;
  let contractAddress: string | undefined;
  let functionSelector: string | undefined;
  let triggerData: string | undefined;
  let callValue: bigint | undefined;
  let callTokenValue: bigint | undefined;
  let tokenId: bigint | undefined;

  if (contractType === ContractType.TriggerSmartContract) {
    requireParameterType(
      parameterTypeUrl,
      "type.googleapis.com/protocol.TriggerSmartContract"
    );
    requireCanonicalContractParameter(
      parameter,
      canonicalTriggerSmartContractBytes(parameter)
    );
    const trigger = decodeTriggerSmartContract(parameter) as unknown as DecodedTrigger;
    ownerBytes = requiredAddress(trigger.ownerAddress, "owner_address");
    const target = requiredAddress(trigger.contractAddress, "contract_address");
    const data = Buffer.from(trigger.data ?? []);
    if (data.length < 4) throw validationError("TriggerSmartContract calldata is too short", "INVALID_CALLDATA");
    contractAddress = tronHexToBase58(target);
    functionSelector = data.subarray(0, 4).toString("hex");
    triggerData = data.toString("hex");
    callValue = toBigInt(trigger.callValue);
    callTokenValue = toBigInt(trigger.callTokenValue);
    tokenId = toBigInt(trigger.tokenId);
  } else if (contractType === ContractType.TransferContract) {
    requireParameterType(
      parameterTypeUrl,
      "type.googleapis.com/protocol.TransferContract"
    );
    requireCanonicalContractParameter(
      parameter,
      canonicalTransferContractBytes(parameter)
    );
    const transfer = decodeTransferContract(parameter) as unknown as DecodedTransfer;
    ownerBytes = requiredAddress(transfer.ownerAddress, "owner_address");
  } else {
    // All java-tron contracts place owner_address at field 1. Extracting the
    // first length-delimited field lets the gateway identify the signer while
    // still applying the unsupported-contract policy later.
    ownerBytes = extractLengthDelimitedField(parameter, 1);
    requiredAddress(ownerBytes, "owner_address");
  }

  const txId = createHash("sha256").update(rawDataBytes).digest("hex");
  verifySingleOwnerSignature(txId, signatures[0]!, ownerBytes);
  const feeLimitSun = toBigInt(raw.feeLimit);
  if (feeLimitSun < 0n) {
    throw validationError("fee_limit cannot be negative", "INVALID_FEE_LIMIT");
  }

  return {
    txId,
    rawDataBytes,
    transactionBytes,
    ownerAddress: tronHexToBase58(ownerBytes),
    ownerAddressHex: ownerBytes.toString("hex"),
    contractType,
    ...(contractAddress ? { contractAddress } : {}),
    ...(functionSelector ? { functionSelector } : {}),
    ...(triggerData ? { triggerData } : {}),
    ...(callValue !== undefined ? { callValue } : {}),
    ...(callTokenValue !== undefined ? { callTokenValue } : {}),
    ...(tokenId !== undefined ? { tokenId } : {}),
    feeLimitSun,
    refBlockBytes,
    refBlockHash,
    memoLength,
    permissionId,
    expirationMs: toBigInt(raw.expiration),
    timestampMs: toBigInt(raw.timestamp),
    signatures
  };
}

function requireParameterType(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new GatewayError(
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "Transaction contract parameter type does not match the declared contract type",
      "CONTRACT_PARAMETER_TYPE_MISMATCH"
    );
  }
}

function requireCanonicalContractParameter(actual: Buffer, canonical: Buffer): void {
  if (!canonical.equals(actual)) {
    throw new GatewayError(
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "Transaction contract parameter is not in java-tron's canonical protobuf form",
      "NON_CANONICAL_CONTRACT_PARAMETER"
    );
  }
}

function requiredAddress(value: ProtoBytes | undefined, name: string): Buffer {
  const bytes = Buffer.from(value ?? []);
  if (bytes.length !== 21 || bytes[0] !== 0x41) {
    throw validationError(`${name} is not a valid TRON address`, "INVALID_ADDRESS");
  }
  return bytes;
}

function toBigInt(value: number | string | bigint | { toString(): string } | undefined): bigint {
  if (value === undefined) return 0n;
  return BigInt(value.toString());
}

function verifySingleOwnerSignature(txId: string, signature: Buffer, ownerAddress: Buffer): void {
  if (signature.length !== 65) {
    throw validationError("Invalid TRON signature length", "INVALID_SIGNATURE_LENGTH");
  }
  const canonical = signature;
  const r = `0x${canonical.subarray(0, 32).toString("hex")}`;
  const s = `0x${canonical.subarray(32, 64).toString("hex")}`;
  const recovery = canonical[64];
  if (recovery !== 0 && recovery !== 1 && recovery !== 27 && recovery !== 28) {
    throw validationError("Invalid TRON signature recovery byte", "INVALID_SIGNATURE_RECOVERY");
  }
  const yParity = (recovery >= 27 ? recovery - 27 : recovery) as 0 | 1;
  let ethereumAddress: string;
  try {
    ethereumAddress = recoverAddress(`0x${txId}`, Signature.from({ r, s, yParity }));
  } catch (error) {
    throw validationError("TRON signature recovery failed", "SIGNATURE_RECOVERY_FAILED", error);
  }
  const recoveredTronHex = `41${ethereumAddress.slice(2).toLowerCase()}`;
  if (recoveredTronHex !== ownerAddress.toString("hex")) {
    throw validationError("Signature does not authorize owner_address", "SIGNER_OWNER_MISMATCH");
  }
}

function validationError(message: string, code: string, cause?: unknown): GatewayError {
  return new GatewayError(ReturnCode.SIGERROR, message, code, cause ? { cause } : undefined);
}
