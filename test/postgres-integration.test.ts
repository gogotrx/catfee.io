import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProviderSecretCipher } from "../src/providers/crypto.js";
import { EnergyProviderRepository } from "../src/providers/repository.js";
import { GatewayRepository } from "../src/repository.js";
import { tryAcquireGatewaySingleton } from "../src/db.js";

const candidateUrl = process.env.TEST_DATABASE_URL;
const safeDatabaseUrl = candidateUrl && isPreflightDatabase(candidateUrl) ? candidateUrl : undefined;
if (candidateUrl && !safeDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must name a seamless_preflight_* database");
}

describe.skipIf(!safeDatabaseUrl)("PostgreSQL production invariants", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: safeDatabaseUrl!, max: 6 });
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE
         sponsor_address_claims,
         energy_provider_budget_ledger,
         energy_provider_orders,
         energy_providers,
         resource_leases,
         broadcast_requests,
         address_bindings
       RESTART IDENTITY CASCADE`
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("allows only one reservation when two connections race for the final paid budget slot", async () => {
    const providers = new EnergyProviderRepository(
      pool,
      ProviderSecretCipher.fromEncodedKey("11".repeat(32)),
      { maxEnergyPerOrder: 100, dailyOrderLimit: 1, dailyEnergyLimit: 100 }
    );
    const provider = await providers.createProvider({
      type: "kuaizu",
      name: "preflight",
      apiKey: "not-a-real-provider-key",
      rentTime: 15,
      enabled: false,
      maxEnergyPerOrder: 100,
      dailyOrderLimit: 1,
      dailyEnergyLimit: 100
    });
    await providers.updateProvider(provider.id, { enabled: true });
    const firstTx = "a".repeat(64);
    const secondTx = "b".repeat(64);
    await insertBroadcastRequest(pool, firstTx, "TFirstPreflightOwner");
    await insertBroadcastRequest(pool, secondTx, "TSecondPreflightOwner");
    const firstOrder = await providers.beginOrder({
      txId: firstTx,
      receiveAddress: "TFirstPreflightOwner",
      amount: 100
    });
    const secondOrder = await providers.beginOrder({
      txId: secondTx,
      receiveAddress: "TSecondPreflightOwner",
      amount: 100
    });

    const results = await Promise.all([
      providers.startAttempt(firstOrder.order.id, provider.id, 100),
      providers.startAttempt(secondOrder.order.id, provider.id, 100)
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    const budget = await providers.getBudgetStatus();
    expect(budget.usedOrders).toBe(1n);
    expect(budget.usedEnergy).toBe(100n);
    expect(budget.remainingOrders).toBe(0n);
    expect(budget.remainingEnergy).toBe(0n);

    const winner = results.find((result) => result !== null);
    if (!winner) throw new Error("Expected one budget reservation winner");
    await providers.markRejected(winner.order.id, winner.provider, "PREFLIGHT_REJECTED");
    const releasedBudget = await providers.getBudgetStatus();
    expect(releasedBudget.usedOrders).toBe(0n);
    expect(releasedBudget.usedEnergy).toBe(0n);

    const retryOrder = winner.order.id === firstOrder.order.id ? secondOrder : firstOrder;
    const retry = await providers.startAttempt(retryOrder.order.id, provider.id, 100);
    if (!retry) throw new Error("Expected released budget to be reusable");
    const accepted = await providers.markAccepted(retry.order.id, retry.provider, {
      kind: "accepted",
      providerOrderId: "preflight-provider-order",
      providerBalanceTrx: "1",
      orderCostTrx: "0.1",
      delegationTxHash: "d".repeat(64),
      senderAddresses: ["TPreflightSender"]
    });
    expect(accepted.state).toBe("ACCEPTED");
    const chargedBudget = await providers.getBudgetStatus();
    expect(chargedBudget.usedOrders).toBe(1n);
    expect(chargedBudget.usedEnergy).toBe(100n);
  });

  it("holds a database singleton lock for the complete gateway process lifetime", async () => {
    const first = await tryAcquireGatewaySingleton(pool);
    expect(first).not.toBeNull();
    await expect(tryAcquireGatewaySingleton(pool)).resolves.toBeNull();
    await first!.release();

    const replacement = await tryAcquireGatewaySingleton(pool);
    expect(replacement).not.toBeNull();
    await replacement!.release();
  });

  it("atomically refuses a quota reset while an unresolved paid order owns the address", async () => {
    const address = "TAddressWithPaidOrder";
    const txId = "c".repeat(64);
    await pool.query(
      `INSERT INTO address_bindings(
         address, enabled, max_transactions, used_transactions, reserved_transactions
       ) VALUES ($1, TRUE, 10, 5, 0)`,
      [address]
    );
    await insertBroadcastRequest(pool, txId, address);
    await pool.query(
      "INSERT INTO sponsor_address_claims(owner_address, tx_id) VALUES ($1, $2)",
      [address, txId]
    );
    await pool.query(
      `INSERT INTO energy_provider_orders(
         tx_id, receive_address, requested_energy_amount, energy_amount, state, attempts
       ) VALUES ($1, $2, 100, 100, 'UNKNOWN', '[]'::jsonb)`,
      [txId, address]
    );
    const repository = new GatewayRepository(pool);

    await expect(repository.resetBindingUsage(address, 1n, true)).resolves.toBeNull();

    const row = await pool.query<{ used_transactions: string; max_transactions: string }>(
      "SELECT used_transactions, max_transactions FROM address_bindings WHERE address = $1",
      [address]
    );
    expect(row.rows[0]).toEqual({ used_transactions: "5", max_transactions: "10" });
  });

  it("keeps the resource plan, highest arrival observation, and final receipt on one request", async () => {
    const txId = "f".repeat(64);
    await insertBroadcastRequest(pool, txId, "TAuditOwner");
    const repository = new GatewayRepository(pool);
    await repository.upsertResourceAuditPlan(txId, {
      energyEstimateRaw: 72_321n,
      energyEstimateSafe: 83_170n,
      estimateSafetyBps: 11_500,
      energyAvailableBefore: 1_000n,
      packageThreshold: 100_000n,
      energyPackageQuoted: 65_000n,
      energyPriceSun: 100n,
      estimatedEnergyBurnSun: 1_717_000n,
      bandwidthBytes: 401n,
      bandwidthStakedAvailable: 0n,
      bandwidthFreeAvailable: 334n,
      bandwidthSource: "TRX",
      bandwidthUnitPriceSun: 1_000n,
      estimatedBandwidthBurnSun: 67_000n,
      ownerBalanceSun: 121_203_304n,
      feeLimitSun: 30_000_000n,
      minimumFeeLimitSun: 8_317_000n,
      maximumFeeLimitSun: 15_000_000_000n
    });
    await repository.recordEnergyPackageAttempt(txId, 65_000n);
    await repository.recordEnergyArrival(txId, 66_000n);
    await repository.recordEnergyArrival(txId, 65_000n);
    await repository.markFinalized(txId, true, 0, {
      id: txId,
      fee: 67_000,
      result: "SUCCESS",
      receipt: {
        energy_usage_total: 64_321,
        energy_usage: 64_321,
        origin_energy_usage: 0,
        net_usage: 334,
        net_fee: 67_000,
        energy_fee: 0
      }
    });

    const request = await repository.getRequest(txId);
    expect(request).toMatchObject({
      state: "SOLIDIFIED_SUCCESS",
      audit: {
        energyEstimateRaw: 72_321n,
        energyEstimateSafe: 83_170n,
        energyAvailableBefore: 1_000n,
        energyPackageQuoted: 65_000n,
        energyPackageAttempted: 65_000n,
        energyAvailableAfter: 66_000n,
        energyArrivalDelta: 65_000n,
        bandwidthSource: "TRX",
        receiptEnergyUsageTotal: 64_321n,
        receiptNetUsage: 334n,
        receiptNetFeeSun: 67_000n,
        receiptEnergyFeeSun: 0n,
        receiptResult: "SUCCESS"
      }
    });
  });
});

async function insertBroadcastRequest(pool: pg.Pool, txId: string, ownerAddress: string): Promise<void> {
  await pool.query(
    `INSERT INTO broadcast_requests(
       tx_id, owner_address, contract_type, expiration_ms, state
     ) VALUES ($1, $2, 31, $3, 'RECEIVED')`,
    [txId, ownerAddress, String(Date.now() + 120_000)]
  );
}

function isPreflightDatabase(connectionString: string): boolean {
  try {
    const name = new URL(connectionString).pathname.slice(1);
    return /^seamless_preflight_[a-z0-9_]+$/.test(name);
  } catch {
    return false;
  }
}
