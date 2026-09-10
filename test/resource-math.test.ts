import { describe, expect, it } from "vitest";
import {
  applySafetyBasisPoints,
  availableResource,
  estimateSignedTransactionBandwidth,
  planOwnerBandwidthPayment,
  resourceUnitsToStakeSun
} from "../src/resource-math.js";

describe("resource math", () => {
  const resource = {
    EnergyLimit: 100_000,
    EnergyUsed: 30_000,
    NetLimit: 2_000,
    NetUsed: 500,
    freeNetLimit: 600,
    freeNetUsed: 100,
    TotalEnergyLimit: 180_000_000_000,
    TotalEnergyWeight: 18_000_000_000,
    TotalNetLimit: 43_200_000_000,
    TotalNetWeight: 43_200_000_000
  };

  it("applies safety margin with upward rounding", () => {
    expect(applySafetyBasisPoints(71_999n, 11_500)).toBe(82_799n);
  });

  it("subtracts used resources", () => {
    expect(availableResource(resource, "ENERGY")).toBe(70_000n);
    expect(availableResource(resource, "BANDWIDTH")).toBe(1_500n);
  });

  it("converts resource units to a minimum whole-TRX stake", () => {
    expect(resourceUnitsToStakeSun(1n, resource, "ENERGY", 1_000_000n)).toBe(1_000_000n);
    expect(resourceUnitsToStakeSun(5_000n, resource, "ENERGY", 1_000_000n)).toBe(500_000_000n);
  });

  it("includes java-tron's result allowance in bandwidth", () => {
    expect(estimateSignedTransactionBandwidth(Buffer.alloc(300))).toBe(364n);
  });

  it("uses one complete bandwidth bucket and otherwise burns the complete byte cost", () => {
    expect(planOwnerBandwidthPayment(1_500n, resource, 1_000n)).toMatchObject({
      source: "STAKED",
      burnSun: 0n
    });
    expect(planOwnerBandwidthPayment(500n, { ...resource, NetLimit: 900, NetUsed: 500 }, 1_000n))
      .toMatchObject({ source: "FREE", burnSun: 500_000n });
    expect(planOwnerBandwidthPayment(800n, {
      ...resource,
      NetLimit: 1_000,
      NetUsed: 500,
      freeNetLimit: 600,
      freeNetUsed: 100
    }, 1_000n)).toMatchObject({
      source: "TRX",
      stakedAvailable: 500n,
      freeAvailable: 500n,
      burnSun: 800_000n
    });
  });
});
