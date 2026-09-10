export const MAX_ENERGY_ORDER_AMOUNT = 10_000_000;
export const DEFAULT_PROVIDER_BUDGET_LIMITS = {
  maxEnergyPerOrder: 200_000,
  dailyOrderLimit: 10,
  dailyEnergyLimit: 1_000_000
} as const;

export const DEFAULT_GLOBAL_PROVIDER_BUDGET_LIMITS = {
  maxEnergyPerOrder: 200_000,
  dailyOrderLimit: 10,
  dailyEnergyLimit: 1_000_000
} as const;

export type EnergyProviderBudgetLimits = {
  maxEnergyPerOrder: number;
  dailyOrderLimit: number;
  dailyEnergyLimit: number;
};

export type EnergyProviderUsage = {
  reservedOrders: bigint;
  reservedEnergy: bigint;
  chargedOrders: bigint;
  chargedEnergy: bigint;
  releasedOrders: bigint;
  releasedEnergy: bigint;
  usedOrders: bigint;
  usedEnergy: bigint;
};

export type EnergyProviderBudgetStatus = EnergyProviderBudgetLimits & EnergyProviderUsage & {
  window: "UTC_DAY";
  utcDay: string;
  maxEnergyPerOrder: number;
  remainingOrders: bigint;
  remainingEnergy: bigint;
  providers: readonly EnergyProviderBudgetProviderStatus[];
};

export type EnergyProviderBudgetProviderStatus = EnergyProviderUsage & {
  providerId: bigint;
  type: string;
  name: string;
  enabled: boolean;
  maxEnergyPerOrder: number;
  dailyOrderLimit: number;
  dailyEnergyLimit: number;
  remainingOrders: bigint;
  remainingEnergy: bigint;
};

export type EnergyProviderConfig = {
  id: bigint;
  type: string;
  name: string;
  enabled: boolean;
  priority: number;
  rentTime: 1 | 15;
  maxEnergyPerOrder: number;
  dailyOrderLimit: number;
  dailyEnergyLimit: number;
  apiKeyConfigured: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type EnergyProviderCredential = EnergyProviderConfig & {
  apiKey: string;
};

export type EnergyProviderOrderState =
  | "PENDING"
  | "ORDERING"
  | "ACCEPTED"
  | "FULFILLED"
  | "REJECTED"
  | "UNKNOWN";

export type EnergyProviderOrderEvent = {
  state: EnergyProviderOrderState;
  providerId: string | null;
  providerType: string | null;
  requestedAmount: number | null;
  orderedAmount: number | null;
  code: string | null;
  at: string;
};

export type EnergyProviderOrder = {
  id: bigint;
  txId: string;
  providerId: bigint | null;
  receiveAddress: string;
  requestedAmount: number;
  amount: number;
  rentTime: 1 | 15 | null;
  state: EnergyProviderOrderState;
  providerOrderId: string | null;
  providerBalanceTrx: string | null;
  orderCostTrx: string | null;
  delegationTxHash: string | null;
  senderAddresses: readonly string[];
  failureCode: string | null;
  failureMessage: string | null;
  attempts: readonly EnergyProviderOrderEvent[];
  createdAt: Date;
  updatedAt: Date;
};

export type RentEnergyRequest = {
  apiKey: string;
  receiveAddress: string;
  amount: number;
  rentTime: 1 | 15;
};

export type QueryProviderAccountRequest = {
  apiKey: string;
};

export type ProviderAccountStatus = {
  balanceTrx: string;
  priceSunPerEnergy: string;
  packageAmounts: readonly number[];
};

export type ProviderAccountSnapshot = {
  providerId: bigint;
  providerType: string;
  balanceTrx: string;
  priceSunPerEnergy: string;
  packages: readonly {
    energy: number;
    estimatedCostTrx: string;
  }[];
  checkedAt: Date;
};

export type RentEnergyResult =
  | {
      kind: "accepted";
      providerOrderId: string;
      providerBalanceTrx: string;
      orderCostTrx: string;
      delegationTxHash: string;
      senderAddresses: readonly string[];
    }
  | {
      kind: "rejected";
      code: string;
    };

export interface EnergyProviderAdapter {
  readonly type: string;
  resolveEnergyAmount(requestedAmount: number): number | null;
  resolveEnergyAmountAtLeast?(requestedAmount: number, minimumAmount: number): number | null;
  rentEnergy(request: RentEnergyRequest): Promise<RentEnergyResult>;
  queryAccountStatus?(request: QueryProviderAccountRequest): Promise<ProviderAccountStatus>;
}

export type OrderEnergyInput = {
  txId: string;
  receiveAddress: string;
  amount: number;
  minimumPackageAmount?: number;
  providerRequestDeadlineMs: number;
};

export type OrderEnergyResult = {
  kind: "accepted" | "rejected" | "unknown" | "duplicate";
  order: EnergyProviderOrder;
};

export type ProviderCredentialContext = {
  providerType: string;
  credentialId: string;
  version: number;
};

export class AmbiguousProviderError extends Error {
  constructor(public readonly code: string, message = "The provider request outcome is unknown") {
    super(message);
    this.name = "AmbiguousProviderError";
  }
}

export class EnergyOrderConflictError extends Error {
  constructor() {
    super("The transaction id is already associated with a different energy order");
    this.name = "EnergyOrderConflictError";
  }
}

export class ProviderCredentialError extends Error {
  constructor(public readonly provider: EnergyProviderConfig) {
    super("The configured provider credential is unavailable");
    this.name = "ProviderCredentialError";
  }
}

export class ProviderAccountQueryError extends Error {
  constructor(public readonly code: string) {
    super("The provider account status is temporarily unavailable");
    this.name = "ProviderAccountQueryError";
  }
}

export class ProviderAccountQueryUnsupportedError extends Error {
  constructor() {
    super("The provider does not support account-status queries");
    this.name = "ProviderAccountQueryUnsupportedError";
  }
}

export class ProviderMustBeDisabledError extends Error {
  constructor() {
    super("The provider must be disabled before changing paid execution settings");
    this.name = "ProviderMustBeDisabledError";
  }
}

export class PotentiallyChargedProviderError extends Error {
  readonly internalCode = "ENERGY_PROVIDER_POTENTIALLY_CHARGED";

  constructor(public readonly txId: string) {
    super("The provider may have charged this order; automatic retry is forbidden");
    this.name = "PotentiallyChargedProviderError";
  }
}
