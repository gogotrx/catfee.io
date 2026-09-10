export const BROADCAST_PATH = "/protocol.Wallet/BroadcastTransaction";

export const ContractType = {
  TransferContract: 1,
  TriggerSmartContract: 31,
  DelegateResourceContract: 57,
  UnDelegateResourceContract: 58
} as const;

export const ReturnCode = {
  SUCCESS: 0,
  SIGERROR: 1,
  CONTRACT_VALIDATE_ERROR: 2,
  CONTRACT_EXE_ERROR: 3,
  BANDWITH_ERROR: 4,
  DUP_TRANSACTION_ERROR: 5,
  TAPOS_ERROR: 6,
  TOO_BIG_TRANSACTION_ERROR: 7,
  TRANSACTION_EXPIRATION_ERROR: 8,
  SERVER_BUSY: 9,
  NO_CONNECTION: 10,
  NOT_ENOUGH_EFFECTIVE_CONNECTION: 11,
  BLOCK_UNSOLIDIFIED: 12,
  OTHER_ERROR: 20
} as const;

export type ResourceType = "ENERGY" | "BANDWIDTH";

export type InspectedTransaction = {
  txId: string;
  rawDataBytes: Buffer;
  transactionBytes: Buffer;
  ownerAddress: string;
  ownerAddressHex: string;
  contractType: number;
  contractAddress?: string;
  functionSelector?: string;
  triggerData?: string;
  callValue?: bigint;
  callTokenValue?: bigint;
  tokenId?: bigint;
  feeLimitSun: bigint;
  refBlockBytes: Buffer;
  refBlockHash: Buffer;
  memoLength: number;
  permissionId: number;
  expirationMs: bigint;
  timestampMs: bigint;
  signatures: readonly Buffer[];
};

export type ResourceRequirement = {
  resourceType: ResourceType;
  estimated: bigint;
  required: bigint;
  available: bigint;
  deficit: bigint;
  balanceSun: bigint;
};

export type RawGrpcResponse = {
  headers: Record<string, string | number | readonly string[]>;
  body: Buffer;
  trailers: Record<string, string | number | readonly string[]>;
};

export type BeginRequestResult =
  | { kind: "created" }
  | { kind: "cached"; response: Buffer; grpcStatus: string }
  | { kind: "in_progress"; state: string };

export type AddressBinding = {
  address: string;
  label: string | null;
  enabled: boolean;
  maxTransactions: bigint | null;
  usedTransactions: bigint;
  reservedTransactions: bigint;
  expiresAt: Date | null;
};

export type LeaseRecord = {
  id: bigint;
  txId: string;
  resourceType: ResourceType;
  resourceOwnerAddress: string;
  receiverAddress: string;
  balanceSun: bigint;
  delegateTxId: string | null;
  undelegateTxId: string | null;
  state: string;
  releaseAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export class GatewayError extends Error {
  constructor(
    public readonly returnCode: number,
    public readonly publicMessage: string,
    public readonly internalCode: string,
    options?: ErrorOptions
  ) {
    super(publicMessage, options);
    this.name = "GatewayError";
  }
}
