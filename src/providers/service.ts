import { normalizeTronAddress } from "../tron-address.js";
import { EnergyProviderRegistry } from "./registry.js";
import { EnergyProviderRepository } from "./repository.js";
import {
  AmbiguousProviderError,
  EnergyOrderConflictError,
  MAX_ENERGY_ORDER_AMOUNT,
  PotentiallyChargedProviderError,
  ProviderAccountQueryUnsupportedError,
  ProviderCredentialError,
  type EnergyProviderAdapter,
  type ProviderAccountSnapshot,
  type OrderEnergyInput,
  type OrderEnergyResult,
  type EnergyProviderOrder
} from "./types.js";

const ACCOUNT_SNAPSHOT_CACHE_MS = 5_000;

export class EnergyProviderService {
  private readonly accountSnapshotCache = new Map<string, {
    expiresAt: number;
    snapshot: ProviderAccountSnapshot;
  }>();
  private readonly accountSnapshotQueries = new Map<string, Promise<ProviderAccountSnapshot | null>>();

  constructor(
    private readonly repository: EnergyProviderRepository,
    private readonly registry: EnergyProviderRegistry
  ) {}

  async quoteMinimumEnergyAmount(
    requestedAmount: number,
    minimumPackageAmount?: number
  ): Promise<number | null> {
    validateEnergyAmount(requestedAmount);
    if (minimumPackageAmount !== undefined) validateEnergyAmount(minimumPackageAmount);
    const providers = await this.repository.listEnabledProviders();
    let minimum: number | null = null;
    for (const candidate of providers) {
      const adapter = this.registry.get(candidate.type);
      const amount = adapter
        ? resolveEnergyAmount(adapter, requestedAmount, minimumPackageAmount)
        : null;
      if (amount === null || amount > candidate.maxEnergyPerOrder) continue;
      if (minimum === null || amount < minimum) minimum = amount;
    }
    return minimum;
  }

  async queryAccountSnapshot(providerId: bigint): Promise<ProviderAccountSnapshot | null> {
    const cacheKey = providerId.toString();
    const cached = this.accountSnapshotCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
    if (cached) this.accountSnapshotCache.delete(cacheKey);
    const running = this.accountSnapshotQueries.get(cacheKey);
    if (running) return running;
    const query = this.loadAccountSnapshot(providerId).finally(() => {
      if (this.accountSnapshotQueries.get(cacheKey) === query) {
        this.accountSnapshotQueries.delete(cacheKey);
      }
    });
    this.accountSnapshotQueries.set(cacheKey, query);
    const snapshot = await query;
    if (snapshot) {
      this.accountSnapshotCache.set(cacheKey, {
        expiresAt: Date.now() + ACCOUNT_SNAPSHOT_CACHE_MS,
        snapshot
      });
    }
    return snapshot;
  }

  private async loadAccountSnapshot(providerId: bigint): Promise<ProviderAccountSnapshot | null> {
    const provider = await this.repository.getProviderCredential(providerId);
    if (!provider) return null;
    const adapter = this.registry.get(provider.type);
    if (!adapter?.queryAccountStatus) throw new ProviderAccountQueryUnsupportedError();
    const status = await adapter.queryAccountStatus({ apiKey: provider.apiKey });
    const packageAmounts = [...new Set(status.packageAmounts)];
    if (packageAmounts.length < 1 || packageAmounts.length > 100) {
      throw new ProviderAccountQueryUnsupportedError();
    }
    return {
      providerId: provider.id,
      providerType: provider.type,
      balanceTrx: status.balanceTrx,
      priceSunPerEnergy: status.priceSunPerEnergy,
      packages: packageAmounts.map((energy) => {
        validateEnergyAmount(energy);
        return {
          energy,
          estimatedCostTrx: estimateCostTrx(status.priceSunPerEnergy, energy)
        };
      }),
      checkedAt: new Date()
    };
  }

  async orderEnergy(input: OrderEnergyInput): Promise<OrderEnergyResult> {
    const normalized = validateOrderInput(input);
    const begun = await this.repository.beginOrder(normalized);
    if (begun.kind === "existing") {
      if (
        begun.order.receiveAddress !== normalized.receiveAddress ||
        begun.order.requestedAmount !== normalized.amount
      ) {
        throw new EnergyOrderConflictError();
      }
      if (begun.order.state !== "PENDING") return { kind: "duplicate", order: begun.order };
    }

    const providers = await this.repository.listEnabledProviders();
    if (providers.length === 0) {
      const order = await this.repository.rejectWithoutProvider(begun.order.id, "NO_ENABLED_PROVIDER");
      return { kind: "rejected", order };
    }

    let lastRejected = begun.order.state === "REJECTED" ? begun.order : null;
    let hasCompatiblePackage = false;
    let hasPackageMismatch = false;
    for (const candidate of providers) {
      const adapter = this.registry.get(candidate.type);
      if (!adapter) continue;
      const actualAmount = resolveEnergyAmount(
        adapter,
        normalized.amount,
        normalized.minimumPackageAmount
      );
      if (actualAmount === null) {
        hasPackageMismatch = true;
        continue;
      }
      hasCompatiblePackage = true;
      let attempt;
      try {
        attempt = await this.repository.startAttempt(begun.order.id, candidate.id, actualAmount);
      } catch (error) {
        if (!(error instanceof ProviderCredentialError)) throw error;
        lastRejected = await this.repository.markRejected(
          begun.order.id,
          error.provider,
          "CREDENTIAL_INVALID"
        );
        continue;
      }
      if (!attempt) {
        const current = await this.repository.getOrderByTxId(normalized.txId);
        if (current && current.state !== "PENDING" && current.state !== "REJECTED") {
          return { kind: "duplicate", order: current };
        }
        continue;
      }
      const provider = attempt.provider;
      if (Date.now() >= normalized.providerRequestDeadlineMs) {
        const order = await this.repository.markRejected(
          begun.order.id,
          provider,
          "TRANSACTION_TTL_ELAPSED"
        );
        return { kind: "rejected", order };
      }
      let outcome;
      try {
        outcome = await adapter.rentEnergy({
          apiKey: provider.apiKey,
          receiveAddress: normalized.receiveAddress,
          amount: actualAmount,
          rentTime: provider.rentTime
        });
      } catch (error) {
        const code = error instanceof AmbiguousProviderError
          ? error.code
          : "PROVIDER_EXECUTION_AMBIGUOUS";
        try {
          const order = await this.repository.markUnknown(begun.order.id, provider, code);
          return { kind: "unknown", order };
        } catch {
          throw new PotentiallyChargedProviderError(normalized.txId);
        }
      }
      if (outcome.kind === "rejected") {
        lastRejected = await this.repository.markRejected(
          begun.order.id,
          provider,
          outcome.code
        );
        continue;
      }
      try {
        const order = await this.repository.markAccepted(begun.order.id, provider, outcome);
        return { kind: "accepted", order };
      } catch {
        try {
          await this.repository.markUnknown(
            begun.order.id,
            provider,
            "ACCEPTED_PERSISTENCE_FAILED"
          );
        } catch {
          // The original transaction id remains the no-retry boundary even if auditing is unavailable.
        }
        throw new PotentiallyChargedProviderError(normalized.txId);
      }
    }
    if (lastRejected) return { kind: "rejected", order: lastRejected };
    const current = await this.repository.getOrderByTxId(normalized.txId);
    if (!current || current.state === "PENDING") {
      const order = await this.repository.rejectWithoutProvider(
        begun.order.id,
        !hasCompatiblePackage && hasPackageMismatch
          ? "NO_ELIGIBLE_PROVIDER_PACKAGE"
          : "NO_ELIGIBLE_PROVIDER_CAPACITY"
      );
      return { kind: "rejected", order };
    }
    if (current.state === "REJECTED") return { kind: "rejected", order: current };
    return { kind: "duplicate", order: current };
  }

  async markFulfilled(txId: string): Promise<EnergyProviderOrder> {
    return this.repository.markFulfilled(normalizeTxId(txId));
  }

  async markConfirmationTimeout(
    txId: string
  ): Promise<EnergyProviderOrder> {
    return this.repository.markConfirmationTimeout(normalizeTxId(txId));
  }

  async recoverInterruptedOrders(): Promise<number> {
    return this.repository.recoverInterruptedOrders();
  }
}

function resolveEnergyAmount(
  adapter: EnergyProviderAdapter,
  requestedAmount: number,
  minimumPackageAmount?: number
): number | null {
  const resolved = adapter.resolveEnergyAmount(requestedAmount);
  if (resolved === null) return null;
  if (minimumPackageAmount === undefined || resolved >= minimumPackageAmount) return resolved;
  const upgraded = adapter.resolveEnergyAmountAtLeast?.(requestedAmount, minimumPackageAmount) ?? null;
  return upgraded !== null && upgraded >= minimumPackageAmount ? upgraded : null;
}

function validateOrderInput(input: OrderEnergyInput): OrderEnergyInput {
  validateEnergyAmount(input.amount);
  if (input.minimumPackageAmount !== undefined) validateEnergyAmount(input.minimumPackageAmount);
  if (!Number.isSafeInteger(input.providerRequestDeadlineMs) || input.providerRequestDeadlineMs < 1) {
    throw new RangeError("Provider request deadline must be a positive safe-integer timestamp");
  }
  return {
    txId: normalizeTxId(input.txId),
    receiveAddress: normalizeTronAddress(input.receiveAddress),
    amount: input.amount,
    ...(input.minimumPackageAmount !== undefined
      ? { minimumPackageAmount: input.minimumPackageAmount }
      : {}),
    providerRequestDeadlineMs: input.providerRequestDeadlineMs
  };
}

function validateEnergyAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_ENERGY_ORDER_AMOUNT) {
    throw new RangeError(`Energy amount must be between 1 and ${MAX_ENERGY_ORDER_AMOUNT}`);
  }
}

function normalizeTxId(txId: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(txId)) {
    throw new Error("txId must be a 64-character hexadecimal transaction id");
  }
  return txId.toLowerCase();
}

function estimateCostTrx(priceSunPerEnergy: string, energy: number): string {
  const match = /^(\d{1,20})(?:\.(\d{1,18}))?$/.exec(priceSunPerEnergy);
  if (!match?.[1]) throw new ProviderAccountQueryUnsupportedError();
  const fraction = match[2] ?? "";
  const scaledPrice = BigInt(`${match[1]}${fraction}`);
  if (scaledPrice <= 0n) throw new ProviderAccountQueryUnsupportedError();
  return formatDecimal(scaledPrice * BigInt(energy), fraction.length + 6);
}

function formatDecimal(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const digits = value.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
