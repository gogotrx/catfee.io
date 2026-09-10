import type { ResourceType } from "./domain.js";

type AccountResource = Record<string, unknown>;

export type BandwidthPaymentSource = "STAKED" | "FREE" | "TRX";

export type OwnerBandwidthPaymentPlan = {
  requiredBytes: bigint;
  stakedAvailable: bigint;
  freeAvailable: bigint;
  source: BandwidthPaymentSource;
  unitPriceSun: bigint;
  burnSun: bigint;
};

export function applySafetyBasisPoints(value: bigint, basisPoints: number): bigint {
  return divideRoundUp(value * BigInt(basisPoints), 10_000n);
}

export function availableResource(resource: AccountResource, type: ResourceType): bigint {
  if (type === "ENERGY") {
    return nonNegative(readBigInt(resource, "EnergyLimit") - readBigInt(resource, "EnergyUsed"));
  }
  const { staked, free } = bandwidthBuckets(resource);
  // java-tron requires one bucket to cover the complete transaction. It does
  // not combine staked and free bandwidth for one payment.
  return staked > free ? staked : free;
}

export function planOwnerBandwidthPayment(
  requiredBytes: bigint,
  resource: AccountResource,
  unitPriceSun: bigint
): OwnerBandwidthPaymentPlan {
  if (requiredBytes <= 0n) throw new RangeError("Bandwidth bytes must be positive");
  if (unitPriceSun <= 0n) throw new RangeError("Bandwidth unit price must be positive");
  const { staked, free } = bandwidthBuckets(resource);
  const source: BandwidthPaymentSource = staked >= requiredBytes
    ? "STAKED"
    : free >= requiredBytes
      ? "FREE"
      : "TRX";
  return {
    requiredBytes,
    stakedAvailable: staked,
    freeAvailable: free,
    source,
    unitPriceSun,
    // The account's free bucket is also gated by java-tron's global public
    // bandwidth pool, which getaccountresource does not expose. STAKED is the
    // only source that cannot fall back to a full transaction TRX burn.
    burnSun: source === "STAKED" ? 0n : requiredBytes * unitPriceSun
  };
}

export function accountBalanceSun(account: AccountResource): bigint {
  return nonNegative(readBigInt(account, "balance"));
}

export function resourceUnitsToStakeSun(
  units: bigint,
  resource: AccountResource,
  type: ResourceType,
  minimumSun: bigint
): bigint {
  if (units <= 0n) return 0n;
  const totalLimit = readBigInt(resource, type === "ENERGY" ? "TotalEnergyLimit" : "TotalNetLimit");
  const totalWeight = readBigInt(resource, type === "ENERGY" ? "TotalEnergyWeight" : "TotalNetWeight");
  if (totalLimit <= 0n || totalWeight <= 0n) {
    throw new Error(`Node returned invalid global ${type} limit/weight`);
  }
  const calculated = divideRoundUp(units * totalWeight * 1_000_000n, totalLimit);
  return calculated < minimumSun ? minimumSun : calculated;
}

export function estimateSignedTransactionBandwidth(transactionBytes: Buffer): bigint {
  // java-tron accounts for the serialized transaction plus a fixed 64-byte
  // transaction result. The signed transaction bytes already include signatures.
  return BigInt(transactionBytes.length + 64);
}

function readBigInt(record: AccountResource, key: string): bigint {
  const value = record[key];
  if (value === undefined || value === null || value === "") return 0n;
  return BigInt(String(value));
}

function bandwidthBuckets(resource: AccountResource): { staked: bigint; free: bigint } {
  return {
    staked: nonNegative(readBigInt(resource, "NetLimit") - readBigInt(resource, "NetUsed")),
    free: nonNegative(readBigInt(resource, "freeNetLimit") - readBigInt(resource, "freeNetUsed"))
  };
}

function divideRoundUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}
