import { describe, expect, it, vi } from "vitest";
import { EnergyProviderRegistry } from "../src/providers/registry.js";
import type { EnergyProviderRepository } from "../src/providers/repository.js";
import { EnergyProviderService } from "../src/providers/service.js";
import {
  AmbiguousProviderError,
  ProviderAccountQueryUnsupportedError,
  ProviderCredentialError,
  PotentiallyChargedProviderError,
  type EnergyProviderAdapter,
  type EnergyProviderCredential,
  type EnergyProviderOrder
} from "../src/providers/types.js";

const txId = "a".repeat(64);
const receiveAddress = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

describe("EnergyProviderService", () => {
  it("queries a provider account and calculates reference package costs exactly", async () => {
    const accountProvider = provider(7n, "kuaizu", 10);
    const repository = repositoryMock([accountProvider]);
    repository.getProviderCredential.mockResolvedValue(accountProvider);
    const queryAccountStatus = vi.fn().mockResolvedValue({
      balanceTrx: "113.233",
      priceSunPerEnergy: "30",
      packageAmounts: [65_000, 131_000]
    });
    const accountAdapter = {
      ...adapter("kuaizu", vi.fn()),
      queryAccountStatus
    } satisfies EnergyProviderAdapter;
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([accountAdapter])
    );

    const snapshot = await service.queryAccountSnapshot(7n);

    expect(queryAccountStatus).toHaveBeenCalledWith({ apiKey: "kuaizu-secret" });
    expect(snapshot).toMatchObject({
      providerId: 7n,
      providerType: "kuaizu",
      balanceTrx: "113.233",
      priceSunPerEnergy: "30",
      packages: [
        { energy: 65_000, estimatedCostTrx: "1.95" },
        { energy: 131_000, estimatedCostTrx: "3.93" }
      ]
    });
    expect(snapshot?.checkedAt).toBeInstanceOf(Date);
    expect(repository.beginOrder).not.toHaveBeenCalled();
    expect(repository.startAttempt).not.toHaveBeenCalled();
    expect(repository.markAccepted).not.toHaveBeenCalled();

    await expect(service.queryAccountSnapshot(7n)).resolves.toBe(snapshot);
    expect(queryAccountStatus).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent account queries for the same provider", async () => {
    const accountProvider = provider(7n, "kuaizu", 10);
    const repository = repositoryMock([accountProvider]);
    repository.getProviderCredential.mockResolvedValue(accountProvider);
    const status = {
      balanceTrx: "113.233",
      priceSunPerEnergy: "30",
      packageAmounts: [65_000, 131_000]
    };
    let resolveStatus!: (value: typeof status) => void;
    const pendingStatus = new Promise<typeof status>((resolve) => {
      resolveStatus = resolve;
    });
    const queryAccountStatus = vi.fn().mockReturnValue(pendingStatus);
    const accountAdapter = {
      ...adapter("kuaizu", vi.fn()),
      queryAccountStatus
    } satisfies EnergyProviderAdapter;
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([accountAdapter])
    );

    const firstQuery = service.queryAccountSnapshot(7n);
    const secondQuery = service.queryAccountSnapshot(7n);

    await vi.waitFor(() => {
      expect(queryAccountStatus).toHaveBeenCalledTimes(1);
    });
    resolveStatus(status);
    const [firstSnapshot, secondSnapshot] = await Promise.all([firstQuery, secondQuery]);

    expect(repository.getProviderCredential).toHaveBeenCalledTimes(1);
    expect(queryAccountStatus).toHaveBeenCalledTimes(1);
    expect(secondSnapshot).toBe(firstSnapshot);
  });

  it("calculates fractional SUN reference prices without floating-point rounding", async () => {
    const accountProvider = provider(7n, "kuaizu", 10);
    const repository = repositoryMock([accountProvider]);
    repository.getProviderCredential.mockResolvedValue(accountProvider);
    const accountAdapter = {
      ...adapter("kuaizu", vi.fn()),
      queryAccountStatus: vi.fn().mockResolvedValue({
        balanceTrx: "10",
        priceSunPerEnergy: "30.5",
        packageAmounts: [65_000, 131_000]
      })
    } satisfies EnergyProviderAdapter;
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([accountAdapter])
    );

    await expect(service.queryAccountSnapshot(7n)).resolves.toMatchObject({
      packages: [
        { energy: 65_000, estimatedCostTrx: "1.9825" },
        { energy: 131_000, estimatedCostTrx: "3.9955" }
      ]
    });
  });

  it("returns null for a missing provider and rejects adapters without account queries", async () => {
    const repository = repositoryMock([]);
    repository.getProviderCredential.mockResolvedValueOnce(null);
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry()
    );

    await expect(service.queryAccountSnapshot(99n)).resolves.toBeNull();

    const accountProvider = provider(7n, "legacy", 10);
    repository.getProviderCredential.mockResolvedValueOnce(accountProvider);
    const unsupported = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([adapter("legacy", vi.fn())])
    );
    await expect(unsupported.queryAccountSnapshot(7n))
      .rejects.toBeInstanceOf(ProviderAccountQueryUnsupportedError);
  });

  it("falls through only after a definite rejection and respects repository priority", async () => {
    const first = provider(1n, "first", 10);
    const second = provider(2n, "second", 20);
    const firstRent = vi.fn().mockResolvedValue({ kind: "rejected", code: "NO_BALANCE", message: "No balance" });
    const secondRent = vi.fn().mockResolvedValue(successOutcome());
    const repository = repositoryMock([first, second]);
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([
        adapter("first", firstRent),
        adapter("second", secondRent)
      ])
    );

    const result = await service.orderEnergy(orderInput());

    expect(result.kind).toBe("accepted");
    expect(firstRent).toHaveBeenCalledTimes(1);
    expect(secondRent).toHaveBeenCalledTimes(1);
    expect(repository.startAttempt.mock.calls.map((call) => call[1])).toEqual([1n, 2n]);
    expect(repository.startAttempt.mock.calls.map((call) => call[2])).toEqual([65_000, 65_000]);
    expect(repository.markRejected).toHaveBeenCalledTimes(1);
    expect(repository.markAccepted).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on an ambiguous outcome and does not try the next provider", async () => {
    const first = provider(1n, "first", 10);
    const second = provider(2n, "second", 20);
    const firstRent = vi.fn().mockRejectedValue(new AmbiguousProviderError("TIMEOUT"));
    const secondRent = vi.fn().mockResolvedValue(successOutcome());
    const repository = repositoryMock([first, second]);
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([adapter("first", firstRent), adapter("second", secondRent)])
    );

    const result = await service.orderEnergy(orderInput());

    expect(result.kind).toBe("unknown");
    expect(firstRent).toHaveBeenCalledTimes(1);
    expect(secondRent).not.toHaveBeenCalled();
    expect(repository.markUnknown).toHaveBeenCalledWith(10n, first, "TIMEOUT");
  });

  it("returns the existing order without contacting a provider for a duplicate txId", async () => {
    const existing = order("FULFILLED");
    const repository = repositoryMock([]);
    repository.beginOrder.mockResolvedValue({ kind: "existing", order: existing });
    const rent = vi.fn();
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([adapter("first", rent)])
    );

    const result = await service.orderEnergy(orderInput());

    expect(result).toEqual({ kind: "duplicate", order: existing });
    expect(repository.listEnabledProviders).not.toHaveBeenCalled();
    expect(rent).not.toHaveBeenCalled();
  });

  it("compares the original request rather than the rounded package for idempotency", async () => {
    const existing = order("FULFILLED", { requestedAmount: 83_170, amount: 130_000 });
    const repository = repositoryMock([]);
    repository.beginOrder.mockResolvedValue({ kind: "existing", order: existing });
    const rent = vi.fn();
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([adapter("first", rent)])
    );

    const result = await service.orderEnergy({ ...orderInput(), amount: 83_170 });

    expect(result).toEqual({ kind: "duplicate", order: existing });
    expect(repository.listEnabledProviders).not.toHaveBeenCalled();
    expect(rent).not.toHaveBeenCalled();
  });

  it("can reserve and send a fixed package smaller than the raw estimate", async () => {
    const first = provider(1n, "first", 10);
    const rent = vi.fn().mockResolvedValue(successOutcome());
    const repository = repositoryMock([first], 83_170);
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([
        adapter("first", rent, (requested) => requested < 100_000 ? 65_000 : 131_000)
      ])
    );

    const result = await service.orderEnergy({ ...orderInput(), amount: 83_170 });

    expect(result.kind).toBe("accepted");
    expect(repository.startAttempt).toHaveBeenCalledWith(10n, 1n, 65_000);
    expect(rent).toHaveBeenCalledWith(expect.objectContaining({ amount: 65_000 }));
  });

  it("rejects explicitly without reserving or sending HTTP when no package can cover the request", async () => {
    const first = provider(1n, "first", 10);
    const rent = vi.fn();
    const repository = repositoryMock([first], 130_001);
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([adapter("first", rent, () => null)])
    );

    const result = await service.orderEnergy({ ...orderInput(), amount: 130_001 });

    expect(result.kind).toBe("rejected");
    expect(repository.startAttempt).not.toHaveBeenCalled();
    expect(rent).not.toHaveBeenCalled();
    expect(repository.rejectWithoutProvider).toHaveBeenCalledWith(
      10n,
      "NO_ELIGIBLE_PROVIDER_PACKAGE"
    );
  });

  it("skips an incompatible package and falls through to the next provider", async () => {
    const first = provider(1n, "first", 10);
    const second = provider(2n, "second", 20);
    const firstRent = vi.fn();
    const secondRent = vi.fn().mockResolvedValue(successOutcome());
    const repository = repositoryMock([first, second], 83_170);
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([
        adapter("first", firstRent, () => null),
        adapter("second", secondRent, () => 130_000)
      ])
    );

    const result = await service.orderEnergy({ ...orderInput(), amount: 83_170 });

    expect(result.kind).toBe("accepted");
    expect(firstRent).not.toHaveBeenCalled();
    expect(repository.startAttempt).toHaveBeenCalledTimes(1);
    expect(repository.startAttempt).toHaveBeenCalledWith(10n, 2n, 130_000);
    expect(secondRent).toHaveBeenCalledWith(expect.objectContaining({ amount: 130_000 }));
  });

  it("skips one corrupt credential without decrypting or blocking later providers", async () => {
    const broken = provider(1n, "first", 10);
    const second = provider(2n, "second", 20);
    const repository = repositoryMock([broken, second]);
    repository.startAttempt
      .mockRejectedValueOnce(new ProviderCredentialError(broken))
      .mockResolvedValueOnce({ order: order("ORDERING"), provider: second });
    const secondRent = vi.fn().mockResolvedValue(successOutcome());
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([
        adapter("first", vi.fn()),
        adapter("second", secondRent)
      ])
    );

    const result = await service.orderEnergy(orderInput());

    expect(result.kind).toBe("accepted");
    expect(repository.markRejected).toHaveBeenCalledWith(10n, broken, "CREDENTIAL_INVALID");
    expect(secondRent).toHaveBeenCalledTimes(1);
  });

  it("quotes the smallest compatible package and ignores provider capacity mismatches", async () => {
    const first = { ...provider(1n, "first", 10), maxEnergyPerOrder: 65_000 };
    const second = provider(2n, "second", 20);
    const repository = repositoryMock([first, second], 100_000);
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([
        adapter("first", vi.fn(), () => 131_000),
        adapter("second", vi.fn(), () => 130_000)
      ])
    );

    await expect(service.quoteMinimumEnergyAmount(100_000)).resolves.toBe(130_000);
  });

  it("upgrades a provider package to satisfy a strict no-burn floor", async () => {
    const first = provider(1n, "first", 10);
    const repository = repositoryMock([first], 72_321);
    const rent = vi.fn().mockResolvedValue(successOutcome());
    const strictAdapter = {
      ...adapter("first", rent, () => 65_000),
      resolveEnergyAmountAtLeast: vi.fn((_requested: number, minimum: number) =>
        minimum <= 131_000 ? 131_000 : null
      )
    } satisfies EnergyProviderAdapter;
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([strictAdapter])
    );

    await expect(service.quoteMinimumEnergyAmount(72_321, 83_170)).resolves.toBe(131_000);
    const result = await service.orderEnergy({
      ...orderInput(),
      amount: 72_321,
      minimumPackageAmount: 83_170
    });

    expect(result.kind).toBe("accepted");
    expect(strictAdapter.resolveEnergyAmountAtLeast).toHaveBeenCalledWith(72_321, 83_170);
    expect(repository.startAttempt).toHaveBeenCalledWith(10n, 1n, 131_000);
    expect(rent).toHaveBeenCalledWith(expect.objectContaining({ amount: 131_000 }));
  });

  it("will not select a package below the preflight floor", async () => {
    const first = provider(1n, "first", 10);
    const second = provider(2n, "second", 20);
    const firstRent = vi.fn();
    const secondRent = vi.fn().mockResolvedValue(successOutcome());
    const repository = repositoryMock([first, second], 100_000);
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([
        adapter("first", firstRent, () => 65_000),
        adapter("second", secondRent, () => 131_000)
      ])
    );

    const result = await service.orderEnergy({
      ...orderInput(),
      amount: 100_000,
      minimumPackageAmount: 131_000
    });

    expect(result.kind).toBe("accepted");
    expect(firstRent).not.toHaveBeenCalled();
    expect(secondRent).toHaveBeenCalledWith(expect.objectContaining({ amount: 131_000 }));
  });

  it("raises a recognizable potentially-charged error if acceptance cannot be persisted", async () => {
    const first = provider(1n, "first", 10);
    const repository = repositoryMock([first]);
    repository.markAccepted.mockRejectedValue(new Error("database unavailable"));
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([adapter("first", vi.fn().mockResolvedValue(successOutcome()))])
    );

    await expect(service.orderEnergy(orderInput())).rejects.toEqual(
      expect.objectContaining({
        name: "PotentiallyChargedProviderError",
        internalCode: "ENERGY_PROVIDER_POTENTIALLY_CHARGED",
        txId
      })
    );
    expect(repository.markUnknown).toHaveBeenCalledWith(
      10n,
      first,
      "ACCEPTED_PERSISTENCE_FAILED"
    );
    await expect(
      Promise.reject(new PotentiallyChargedProviderError(txId))
    ).rejects.not.toHaveProperty("cause");
  });

  it("releases the reservation and stops before HTTP when a database wait crosses the safe deadline", async () => {
    const first = provider(1n, "first", 10);
    const rent = vi.fn();
    const repository = repositoryMock([first]);
    repository.startAttempt.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { order: order("ORDERING"), provider: first };
    });
    const service = new EnergyProviderService(
      repository as unknown as EnergyProviderRepository,
      new EnergyProviderRegistry([adapter("first", rent)])
    );

    const result = await service.orderEnergy({
      ...orderInput(),
      providerRequestDeadlineMs: Date.now() + 1
    });

    expect(result.kind).toBe("rejected");
    expect(rent).not.toHaveBeenCalled();
    expect(repository.markRejected).toHaveBeenCalledWith(
      10n,
      first,
      "TRANSACTION_TTL_ELAPSED"
    );
  });
});

function orderInput() {
  return {
    txId,
    receiveAddress,
    amount: 65_000,
    providerRequestDeadlineMs: Date.now() + 60_000
  };
}

function repositoryMock(providers: EnergyProviderCredential[], requestedAmount = 65_000) {
  return {
    getProviderCredential: vi.fn(),
    beginOrder: vi.fn().mockResolvedValue({
      kind: "created",
      order: order("PENDING", { requestedAmount, amount: requestedAmount })
    }),
    listEnabledProviders: vi.fn().mockResolvedValue(providers),
    startAttempt: vi.fn((_: bigint, id: bigint, amount: number) => Promise.resolve({
      order: order("ORDERING", { requestedAmount, amount }),
      provider: providers.find((entry) => entry.id === id)
    })),
    markRejected: vi.fn().mockResolvedValue(order("REJECTED")),
    markUnknown: vi.fn().mockResolvedValue(order("UNKNOWN")),
    markAccepted: vi.fn().mockResolvedValue(order("ACCEPTED")),
    rejectWithoutProvider: vi.fn().mockResolvedValue(order("REJECTED")),
    getOrderByTxId: vi.fn().mockResolvedValue(null),
    markFulfilled: vi.fn().mockResolvedValue(order("FULFILLED")),
    markConfirmationTimeout: vi.fn().mockResolvedValue(order("UNKNOWN")),
    recoverInterruptedOrders: vi.fn().mockResolvedValue(0)
  };
}

function adapter(
  type: string,
  rentEnergy: ReturnType<typeof vi.fn>,
  resolveEnergyAmount: (requestedAmount: number) => number | null = (amount) => amount
): EnergyProviderAdapter {
  return { type, resolveEnergyAmount, rentEnergy } as EnergyProviderAdapter;
}

function provider(id: bigint, type: string, priority: number): EnergyProviderCredential {
  return {
    id,
    type,
    name: type,
    enabled: true,
    priority,
    rentTime: 1,
    maxEnergyPerOrder: 200_000,
    dailyOrderLimit: 10,
    dailyEnergyLimit: 1_000_000,
    apiKeyConfigured: true,
    apiKey: `${type}-secret`,
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
    updatedAt: new Date("2026-09-10T00:00:00.000Z")
  };
}

function order(
  state: EnergyProviderOrder["state"],
  amounts: { requestedAmount: number; amount: number } = {
    requestedAmount: 65_000,
    amount: 65_000
  }
): EnergyProviderOrder {
  return {
    id: 10n,
    txId,
    providerId: null,
    receiveAddress,
    requestedAmount: amounts.requestedAmount,
    amount: amounts.amount,
    rentTime: null,
    state,
    providerOrderId: null,
    providerBalanceTrx: null,
    orderCostTrx: null,
    delegationTxHash: null,
    senderAddresses: [],
    failureCode: null,
    failureMessage: null,
    attempts: [],
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
    updatedAt: new Date("2026-09-10T00:00:00.000Z")
  };
}

function successOutcome() {
  return {
    kind: "accepted" as const,
    providerOrderId: "123",
    providerBalanceTrx: "10",
    orderCostTrx: "2",
    delegationTxHash: "b".repeat(64),
    senderAddresses: ["T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"]
  };
}
