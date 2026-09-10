import { describe, expect, it, vi } from "vitest";
import type { InspectedTransaction, ResourceRequirement } from "../src/domain.js";
import type { EnergyProviderOrder } from "../src/providers/types.js";
import { PotentiallyChargedProviderError } from "../src/providers/types.js";
import type { GatewayRepository } from "../src/repository.js";
import { PaidProviderOrderError, ResourceService } from "../src/resource-service.js";
import type { SignerClient } from "../src/signer-client.js";
import type { TronNodeApi } from "../src/node-api.js";

const txId = "a".repeat(64);
const ownerAddress = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const transaction = {
  txId,
  ownerAddress,
  transactionBytes: Buffer.alloc(100),
  feeLimitSun: 100_000_000n,
  expirationMs: BigInt(Date.now() + 60_000)
} as InspectedTransaction;
const requirement: ResourceRequirement = {
  resourceType: "ENERGY",
  estimated: 100n,
  required: 100n,
  available: 0n,
  deficit: 100n,
  balanceSun: 0n
};

describe("ResourceService external energy accounting", () => {
  it("consumes quota after provider acceptance and marks the order fulfilled only after ENERGY arrives", async () => {
    const consumeQuota = vi.fn().mockResolvedValue(undefined);
    const node = {
      getAccountResource: vi.fn()
        .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 })
        .mockResolvedValueOnce({ EnergyLimit: 100, EnergyUsed: 0 })
    };
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "accepted", order: providerOrder("ACCEPTED") }),
      markFulfilled: vi.fn().mockResolvedValue(providerOrder("FULFILLED")),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(node, { consumeQuota }, providers);

    await service.prepare(transaction, [requirement]);

    expect(providers.orderEnergy).toHaveBeenCalledTimes(1);
    expect(providers.orderEnergy).toHaveBeenCalledWith(expect.objectContaining({
      txId,
      receiveAddress: ownerAddress,
      amount: 100,
      providerRequestDeadlineMs: expect.any(Number)
    }));
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(consumeQuota).toHaveBeenCalledWith(ownerAddress, txId);
    expect(providers.markFulfilled).toHaveBeenCalledWith(txId);
    expect(providers.markConfirmationTimeout).not.toHaveBeenCalled();
  });

  it("records raw-to-safe diagnostics even when the owner already has enough ENERGY", async () => {
    const audit = vi.fn();
    const packageAttempt = vi.fn();
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const enough: ResourceRequirement = {
      resourceType: "ENERGY",
      estimated: 80n,
      required: 92n,
      available: 100n,
      deficit: 0n,
      balanceSun: 0n
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 100, EnergyUsed: 0 }) },
      {
        consumeQuota: vi.fn(),
        upsertResourceAuditPlan: audit,
        recordEnergyPackageAttempt: packageAttempt
      },
      providers
    );

    await service.prepare(transaction, [enough]);

    expect(providers.orderEnergy).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(txId, expect.objectContaining({
      energyEstimateRaw: 80n,
      energyEstimateSafe: 92n,
      energyAvailableBefore: 100n,
      estimatedEnergyBurnSun: 0n
    }));
    expect(packageAttempt).not.toHaveBeenCalled();
  });

  it("consumes quota and stops after an UNKNOWN result without placing another order", async () => {
    const consumeQuota = vi.fn().mockResolvedValue(undefined);
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "unknown", order: providerOrder("UNKNOWN") }),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota },
      providers
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toBeInstanceOf(PaidProviderOrderError);

    expect(providers.orderEnergy).toHaveBeenCalledTimes(1);
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(providers.markFulfilled).not.toHaveBeenCalled();
    expect(providers.markConfirmationTimeout).not.toHaveBeenCalled();
  });

  it("conservatively consumes quota when persistence fails after a provider may have charged", async () => {
    const consumeQuota = vi.fn().mockResolvedValue(undefined);
    const providers = {
      orderEnergy: vi.fn().mockRejectedValue(new PotentiallyChargedProviderError(txId)),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota },
      providers
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      name: "PaidProviderOrderError",
      providerOrderMayBeCharged: true,
      internalCode: "ENERGY_PROVIDER_POTENTIALLY_CHARGED"
    });

    expect(providers.orderEnergy).toHaveBeenCalledTimes(1);
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(consumeQuota).toHaveBeenCalledWith(ownerAddress, txId);
  });

  it("marks an accepted order UNKNOWN when delivery confirmation times out", async () => {
    const consumeQuota = vi.fn().mockResolvedValue(undefined);
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "accepted", order: providerOrder("ACCEPTED") }),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn().mockResolvedValue(providerOrder("UNKNOWN"))
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota },
      providers,
      { providerConfirmTimeoutMs: 0 }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      name: "PaidProviderOrderError",
      internalCode: "ENERGY_PROVIDER_CONFIRM_TIMEOUT"
    });

    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(providers.markConfirmationTimeout).toHaveBeenCalledWith(txId);
    expect(providers.markFulfilled).not.toHaveBeenCalled();
  });

  it("does not contact a paid provider after preflight consumes the safe TTL budget", async () => {
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers
    );
    const expiring = { ...transaction, expirationMs: BigInt(Date.now() + 5) };

    await expect(service.prepare(expiring, [requirement])).rejects.toMatchObject({
      internalCode: "TRANSACTION_TTL_TOO_SHORT_FOR_PROVIDER"
    });
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("does not order energy for an unactivated account", async () => {
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers,
      { account: {} }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      internalCode: "ENERGY_RECEIVER_NOT_ACTIVATED"
    });
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("allows java-tron to burn owner TRX when neither bandwidth bucket covers the transaction", async () => {
    const upsertResourceAuditPlan = vi.fn();
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "accepted", order: providerOrder("ACCEPTED") }),
      markFulfilled: vi.fn().mockResolvedValue(providerOrder("FULFILLED")),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn()
        .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 })
        .mockResolvedValueOnce({ EnergyLimit: 100, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn(), upsertResourceAuditPlan },
      providers,
      { availableBandwidth: 0 }
    );

    await expect(service.prepare(transaction, [requirement])).resolves.toEqual({
      providerOrderMayBeCharged: true
    });
    expect(providers.orderEnergy).toHaveBeenCalledTimes(1);
    expect(upsertResourceAuditPlan).toHaveBeenCalledWith(txId, expect.objectContaining({
      bandwidthSource: "TRX",
      estimatedBandwidthBurnSun: 164_000n
    }));
  });

  it("does not order paid energy when owner bandwidth burn is disabled", async () => {
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers,
      { availableBandwidth: 0, allowOwnerBandwidthBurn: false }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      internalCode: "OWNER_BANDWIDTH_BURN_DISABLED"
    });
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("guards a complete free bandwidth bucket against the unavailable global-pool fallback", async () => {
    const audit = vi.fn();
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn(), upsertResourceAuditPlan: audit },
      providers,
      {
        availableBandwidth: 10_000,
        maxOwnerBandwidthBurnSun: 100_000n
      }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      internalCode: "OWNER_BANDWIDTH_BURN_LIMIT_EXCEEDED"
    });
    expect(audit).toHaveBeenCalledWith(txId, expect.objectContaining({
      bandwidthSource: "FREE",
      estimatedBandwidthBurnSun: 164_000n
    }));
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("does not combine partial staked and free bandwidth buckets", async () => {
    const audit = vi.fn();
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({
        EnergyLimit: 0,
        EnergyUsed: 0,
        NetLimit: 100,
        NetUsed: 0
      }) },
      { consumeQuota: vi.fn(), upsertResourceAuditPlan: audit },
      providers,
      { availableBandwidth: 100, maxOwnerBandwidthBurnSun: 100_000n }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      internalCode: "OWNER_BANDWIDTH_BURN_LIMIT_EXCEEDED"
    });
    expect(audit).toHaveBeenCalledWith(txId, expect.objectContaining({
      bandwidthStakedAvailable: 100n,
      bandwidthFreeAvailable: 100n,
      bandwidthSource: "TRX",
      estimatedBandwidthBurnSun: 164_000n
    }));
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("does not buy energy when the owner balance cannot cover all projected resource burn", async () => {
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers,
      { availableBandwidth: 0, account: { address: ownerAddress, balance: 163_999 } }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      internalCode: "INSUFFICIENT_OWNER_TRX_FOR_RESOURCES"
    });
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("uses raw estimate for the 65000 package and audits the safe ENERGY remainder", async () => {
    const lowRequirement: ResourceRequirement = {
      resourceType: "ENERGY",
      estimated: 72_321n,
      required: 83_170n,
      available: 0n,
      deficit: 83_170n,
      balanceSun: 0n
    };
    const audit = vi.fn();
    const arrival = vi.fn();
    const packageAttempt = vi.fn();
    const lowOrder = providerOrder("ACCEPTED", { requestedAmount: 72_321, amount: 65_000 });
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "accepted", order: lowOrder }),
      markFulfilled: vi.fn().mockResolvedValue(providerOrder("FULFILLED", {
        requestedAmount: 72_321,
        amount: 65_000
      })),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn()
        .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 })
        .mockResolvedValueOnce({ EnergyLimit: 65_000, EnergyUsed: 0 }) },
      {
        consumeQuota: vi.fn(),
        upsertResourceAuditPlan: audit,
        recordEnergyArrival: arrival,
        recordEnergyPackageAttempt: packageAttempt
      },
      providers,
      {
        quotedPackage: 65_000,
        account: { address: ownerAddress, balance: 5_000_000 }
      }
    );

    await service.prepare(transaction, [lowRequirement]);

    expect(providers.orderEnergy).toHaveBeenCalledWith(expect.objectContaining({
      amount: 72_321,
      minimumPackageAmount: 65_000
    }));
    expect(audit).toHaveBeenCalledWith(txId, expect.objectContaining({
      energyEstimateRaw: 72_321n,
      energyEstimateSafe: 83_170n,
      energyPackageQuoted: 65_000n,
      minimumFeeLimitSun: 8_317_000n,
      estimatedEnergyBurnSun: 1_817_000n
    }));
    expect(packageAttempt).toHaveBeenCalledWith(txId, 65_000n);
    expect(arrival).toHaveBeenCalledWith(txId, 65_000n);
  });

  it("requires a package covering safe ENERGY and rechecks it when owner ENERGY burn is disabled", async () => {
    const strictRequirement: ResourceRequirement = {
      resourceType: "ENERGY",
      estimated: 72_321n,
      required: 83_170n,
      available: 0n,
      deficit: 83_170n,
      balanceSun: 0n
    };
    const audit = vi.fn();
    const strictOrder = providerOrder("ACCEPTED", { requestedAmount: 72_321, amount: 131_000 });
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "accepted", order: strictOrder }),
      markFulfilled: vi.fn().mockResolvedValue(providerOrder("FULFILLED", {
        requestedAmount: 72_321,
        amount: 131_000
      })),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn()
        .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 })
        .mockResolvedValueOnce({ EnergyLimit: 131_000, EnergyUsed: 0 })
        .mockResolvedValueOnce({ EnergyLimit: 131_000, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn(), upsertResourceAuditPlan: audit },
      providers,
      {
        quotedPackage: 131_000,
        allowOwnerEnergyBurn: false
      }
    );

    await expect(service.prepare(transaction, [strictRequirement])).resolves.toEqual({
      providerOrderMayBeCharged: true
    });

    expect(providers.orderEnergy).toHaveBeenCalledWith(expect.objectContaining({
      amount: 72_321,
      minimumPackageAmount: 131_000
    }));
    expect(audit).toHaveBeenCalledWith(txId, expect.objectContaining({
      energyPackageQuoted: 131_000n,
      estimatedEnergyBurnSun: 0n
    }));
  });

  it("stops after a paid order if the final strict ENERGY recheck falls below the safe requirement", async () => {
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "accepted", order: providerOrder("ACCEPTED") }),
      markFulfilled: vi.fn().mockResolvedValue(providerOrder("FULFILLED")),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn()
        .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 })
        .mockResolvedValueOnce({ EnergyLimit: 100, EnergyUsed: 0 })
        .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers,
      { allowOwnerEnergyBurn: false }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      name: "PaidProviderOrderError",
      providerOrderMayBeCharged: true,
      internalCode: "ENERGY_NOT_READY_AFTER_PROVIDER"
    });
    expect(providers.markFulfilled).toHaveBeenCalledWith(txId);
  });

  it("stops after a paid order if the final strict ENERGY recheck is unavailable", async () => {
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "accepted", order: providerOrder("ACCEPTED") }),
      markFulfilled: vi.fn().mockResolvedValue(providerOrder("FULFILLED")),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      {
        getAccountResource: vi.fn()
          .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 })
          .mockResolvedValueOnce({ EnergyLimit: 100, EnergyUsed: 0 })
          .mockRejectedValueOnce(new Error("final account-resource query failed"))
      },
      { consumeQuota: vi.fn() },
      providers,
      { allowOwnerEnergyBurn: false }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      name: "PaidProviderOrderError",
      providerOrderMayBeCharged: true,
      internalCode: "ENERGY_RECHECK_UNAVAILABLE_AFTER_PROVIDER"
    });
    expect(providers.markFulfilled).toHaveBeenCalledWith(txId);
  });

  it("does not mark a historical smaller package fulfilled before the full safe ENERGY target arrives", async () => {
    const strictRequirement: ResourceRequirement = {
      resourceType: "ENERGY",
      estimated: 72_321n,
      required: 83_170n,
      available: 0n,
      deficit: 83_170n,
      balanceSun: 0n
    };
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({
        kind: "accepted",
        order: providerOrder("ACCEPTED", { requestedAmount: 72_321, amount: 65_000 })
      }),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn().mockResolvedValue(providerOrder("UNKNOWN", {
        requestedAmount: 72_321,
        amount: 65_000
      }))
    };
    const service = resourceService(
      {
        getAccountResource: vi.fn()
          .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 })
          .mockResolvedValue({ EnergyLimit: 65_000, EnergyUsed: 0 })
      },
      { consumeQuota: vi.fn() },
      providers,
      {
        quotedPackage: 131_000,
        allowOwnerEnergyBurn: false,
        providerConfirmTimeoutMs: 3
      }
    );

    await expect(service.prepare(transaction, [strictRequirement])).rejects.toMatchObject({
      name: "PaidProviderOrderError",
      internalCode: "ENERGY_PROVIDER_CONFIRM_TIMEOUT"
    });
    expect(providers.markFulfilled).not.toHaveBeenCalled();
    expect(providers.markConfirmationTimeout).toHaveBeenCalledWith(txId);
  });

  it("does not buy a smaller package when fee_limit covers the remainder but not safe total ENERGY", async () => {
    const lowRequirement: ResourceRequirement = {
      resourceType: "ENERGY",
      estimated: 72_321n,
      required: 83_170n,
      available: 0n,
      deficit: 83_170n,
      balanceSun: 0n
    };
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers,
      { quotedPackage: 65_000 }
    );
    const lowFeeTransaction = { ...transaction, feeLimitSun: 2_000_000n };

    await expect(service.prepare(lowFeeTransaction, [lowRequirement])).rejects.toMatchObject({
      internalCode: "INSUFFICIENT_FEE_LIMIT_FOR_ENERGY"
    });
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("rejects fee_limit above the current chain maximum before a paid order", async () => {
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers
    );

    await expect(service.prepare({
      ...transaction,
      feeLimitSun: 15_000_000_001n
    }, [requirement])).rejects.toMatchObject({
      internalCode: "FEE_LIMIT_EXCEEDS_CHAIN_MAXIMUM"
    });
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("rejects a stale or forged TAPOS reference before a paid order", async () => {
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers,
      { taposMatches: false }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      internalCode: "TAPOS_REFERENCE_MISMATCH"
    });
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("does not buy energy for a transaction already visible to the FullNode", async () => {
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers,
      { transactionExists: true }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      returnCode: 5,
      internalCode: "TRANSACTION_ALREADY_VISIBLE_BEFORE_ORDER"
    });
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("rejects an owner signature that no longer meets the on-chain owner threshold", async () => {
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers,
      {
        account: {
          address: ownerAddress,
          owner_permission: {
            id: 0,
            type: "Owner",
            threshold: 2,
            keys: [{ address: ownerAddress, weight: 1 }]
          }
        }
      }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      internalCode: "OWNER_PERMISSION_MISMATCH"
    });
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("keeps paid semantics when delivery polling is temporarily unavailable", async () => {
    const consumeQuota = vi.fn().mockResolvedValue(undefined);
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "accepted", order: providerOrder("ACCEPTED") }),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn().mockResolvedValue(providerOrder("UNKNOWN"))
    };
    const service = resourceService(
      {
        getAccountResource: vi.fn()
          .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 })
          .mockRejectedValue(new Error("temporary node failure"))
      },
      { consumeQuota },
      providers,
      { providerConfirmTimeoutMs: 3 }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      name: "PaidProviderOrderError",
      providerOrderMayBeCharged: true,
      internalCode: "ENERGY_PROVIDER_CONFIRMATION_UNAVAILABLE"
    });
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(providers.markConfirmationTimeout).toHaveBeenCalledWith(txId);
  });

  it("does not let package or arrival audit failure undo an accepted paid order", async () => {
    const consumeQuota = vi.fn().mockResolvedValue(undefined);
    const providers = {
      orderEnergy: vi.fn().mockResolvedValue({ kind: "accepted", order: providerOrder("ACCEPTED") }),
      markFulfilled: vi.fn().mockResolvedValue(providerOrder("FULFILLED")),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      {
        getAccountResource: vi.fn()
          .mockResolvedValueOnce({ EnergyLimit: 0, EnergyUsed: 0 })
          .mockResolvedValueOnce({ EnergyLimit: 100, EnergyUsed: 0 })
      },
      {
        consumeQuota,
        recordEnergyPackageAttempt: vi.fn().mockRejectedValue(new Error("audit unavailable")),
        recordEnergyArrival: vi.fn().mockRejectedValue(new Error("arrival audit unavailable"))
      },
      providers
    );

    await expect(service.prepare(transaction, [requirement])).resolves.toEqual({
      providerOrderMayBeCharged: true
    });
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(providers.markFulfilled).toHaveBeenCalledWith(txId);
  });

  it("fails closed before a paid order when current chain pricing is unavailable", async () => {
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn() },
      providers,
      { resourcePriceError: new Error("chain parameters unavailable") }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toThrow(/chain parameters unavailable/);
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });

  it("records the preflight even when no enabled provider package is available", async () => {
    const audit = vi.fn();
    const providers = {
      orderEnergy: vi.fn(),
      markFulfilled: vi.fn(),
      markConfirmationTimeout: vi.fn()
    };
    const service = resourceService(
      { getAccountResource: vi.fn().mockResolvedValue({ EnergyLimit: 0, EnergyUsed: 0 }) },
      { consumeQuota: vi.fn(), upsertResourceAuditPlan: audit },
      providers,
      { quotedPackage: null }
    );

    await expect(service.prepare(transaction, [requirement])).rejects.toMatchObject({
      internalCode: "ENERGY_PROVIDER_PACKAGE_UNAVAILABLE"
    });
    expect(audit).toHaveBeenCalledWith(txId, expect.objectContaining({
      energyPackageQuoted: null,
      energyEstimateRaw: 100n,
      energyEstimateSafe: 100n
    }));
    expect(providers.orderEnergy).not.toHaveBeenCalled();
  });
});

function resourceService(
  node: { getAccountResource: ReturnType<typeof vi.fn> },
  repository: {
    consumeQuota: ReturnType<typeof vi.fn>;
    upsertResourceAuditPlan?: ReturnType<typeof vi.fn>;
    recordEnergyPackageAttempt?: ReturnType<typeof vi.fn>;
    recordEnergyArrival?: ReturnType<typeof vi.fn>;
  },
  providers: {
    orderEnergy: ReturnType<typeof vi.fn>;
    markFulfilled: ReturnType<typeof vi.fn>;
    markConfirmationTimeout: ReturnType<typeof vi.fn>;
  },
  overrides: {
    providerConfirmTimeoutMs?: number;
    account?: Record<string, unknown>;
    availableBandwidth?: number;
    allowOwnerBandwidthBurn?: boolean;
    allowOwnerEnergyBurn?: boolean;
    maxOwnerBandwidthBurnSun?: bigint;
    maxOwnerEnergyBurnSun?: bigint;
    bandwidthFeeSun?: bigint;
    energyFeeSun?: bigint;
    maxFeeLimitSun?: bigint;
    quotedPackage?: number | null;
    resourcePriceError?: Error;
    taposMatches?: boolean;
    transactionExists?: boolean;
  } = {}
): ResourceService {
  const originalGetAccountResource = node.getAccountResource as unknown as (
    ...args: unknown[]
  ) => Promise<Record<string, unknown>>;
  const enrichedNode = {
    getAccount: vi.fn().mockResolvedValue(
      overrides.account ?? { address: ownerAddress, balance: 1_000_000 }
    ),
    getResourcePrices: overrides.resourcePriceError
      ? vi.fn().mockRejectedValue(overrides.resourcePriceError)
      : vi.fn().mockResolvedValue({
          bandwidthFeeSun: overrides.bandwidthFeeSun ?? 1_000n,
          energyFeeSun: overrides.energyFeeSun ?? 100n,
          maxFeeLimitSun: overrides.maxFeeLimitSun ?? 15_000_000_000n
        }),
    matchesTapos: vi.fn().mockResolvedValue(overrides.taposMatches ?? true),
    hasTransaction: vi.fn().mockResolvedValue(overrides.transactionExists ?? false),
    getAccountResource: vi.fn(async (...args: unknown[]) => ({
      freeNetLimit: overrides.availableBandwidth ?? 10_000,
      freeNetUsed: 0,
      ...await originalGetAccountResource(...args)
    }))
  };
  const enrichedRepository = {
    ...repository,
    upsertResourceAuditPlan: repository.upsertResourceAuditPlan ?? vi.fn().mockResolvedValue(undefined),
    recordEnergyPackageAttempt: repository.recordEnergyPackageAttempt ?? vi.fn().mockResolvedValue(undefined),
    recordEnergyArrival: repository.recordEnergyArrival ?? vi.fn().mockResolvedValue(undefined)
  };
  const enrichedProviders = {
    quoteMinimumEnergyAmount: vi.fn().mockResolvedValue(
      overrides.quotedPackage === undefined ? 100 : overrides.quotedPackage
    ),
    ...providers
  };
  return new ResourceService(
    enrichedNode as unknown as TronNodeApi,
    {} as SignerClient,
    enrichedRepository as unknown as GatewayRepository,
    {
      resourceOwnerAddress: "",
      sponsorEnergy: true,
      sponsorBandwidth: false,
      energySource: "provider",
      estimateSafetyBps: 11_500,
      allowOwnerBandwidthBurn: overrides.allowOwnerBandwidthBurn ?? true,
      maxOwnerBandwidthBurnSun: overrides.maxOwnerBandwidthBurnSun ?? 1_000_000n,
      allowOwnerEnergyBurn: overrides.allowOwnerEnergyBurn ?? true,
      maxOwnerEnergyBurnSun: overrides.maxOwnerEnergyBurnSun ?? 5_000_000n,
      energyPackageThreshold: 100_000,
      minDelegateSun: 1_000_000n,
      delegationConfirmTimeoutMs: 10,
      delegationPollMs: 1,
      providerOrderTimeoutMs: 10,
      providerConfirmTimeoutMs: overrides.providerConfirmTimeoutMs ?? 10,
      providerPollMs: 1,
      minTransactionTtlMs: 0
    },
    enrichedProviders as never
  );
}

function providerOrder(
  state: EnergyProviderOrder["state"],
  amounts: { requestedAmount: number; amount: number } = { requestedAmount: 100, amount: 100 }
): EnergyProviderOrder {
  return {
    id: 1n,
    txId,
    providerId: 1n,
    receiveAddress: ownerAddress,
    requestedAmount: amounts.requestedAmount,
    amount: amounts.amount,
    rentTime: 1,
    state,
    providerOrderId: "provider-order-1",
    providerBalanceTrx: "10",
    orderCostTrx: "2",
    delegationTxHash: "b".repeat(64),
    senderAddresses: ["T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"],
    failureCode: null,
    failureMessage: null,
    attempts: [],
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
    updatedAt: new Date("2026-09-10T00:00:00.000Z")
  };
}
