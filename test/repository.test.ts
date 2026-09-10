import { describe, expect, it, vi } from "vitest";
import { GatewayRepository, summarizeSolidifiedReceipt } from "../src/repository.js";

describe("GatewayRepository binding updates", () => {
  it("preserves every omitted field during an upsert conflict", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          address: "TAddress",
          label: "replacement",
          enabled: false,
          max_transactions: "20",
          used_transactions: "3",
          reserved_transactions: "0",
          expires_at: null
        }
      ]
    });
    const repository = new GatewayRepository({ query } as never);

    await repository.upsertBinding({ address: "TAddress", label: "replacement" });

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("CASE WHEN $6::boolean");
    expect(sql).toContain("CASE WHEN $9::boolean");
    expect(parameters).toEqual([
      "TAddress",
      "replacement",
      null,
      null,
      true,
      true,
      false,
      false,
      false
    ]);
  });

  it("rejects unsafe transaction limits before querying the database", async () => {
    const query = vi.fn();
    const repository = new GatewayRepository({ query } as never);

    await expect(
      repository.upsertBinding({ address: "TAddress", maxTransactions: 1_000_001n })
    ).rejects.toThrow(/1000000/);
    await expect(repository.resetBindingUsage("TAddress", -1n)).rejects.toThrow(/between 0/);
    expect(query).not.toHaveBeenCalled();
  });

  it("checks paid-provider activity inside the quota-reset update", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new GatewayRepository({ query } as never);

    await expect(repository.resetBindingUsage("TAddress", 1n, true)).resolves.toBeNull();

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("NOT $4::boolean");
    expect(sql).toContain("sponsor_address_claims");
    expect(sql).toContain("e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')");
    expect(parameters).toEqual(["TAddress", true, "1", true]);
  });

  it("refuses an unlimited binding when paid-provider mode requires a finite limit", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{
          address: "TAddress",
          label: null,
          enabled: true,
          max_transactions: null,
          used_transactions: "0",
          reserved_transactions: "0",
          expires_at: null
        }]
      })
      .mockResolvedValueOnce(undefined);
    const client = { query, release: vi.fn() };
    const repository = new GatewayRepository({ connect: vi.fn().mockResolvedValue(client) } as never);

    await expect(repository.reserveQuota("TAddress", "a".repeat(64), true)).resolves.toBe(false);

    expect(query.mock.calls.map((call) => String(call[0]))).toEqual([
      "BEGIN",
      expect.stringContaining("FROM address_bindings"),
      "ROLLBACK"
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("uses a persistent unique address claim and can discard an unprepared loser", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ owner_address: "TAddress" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const repository = new GatewayRepository({ query } as never);

    await expect(repository.tryAcquireAddressClaim("TAddress", "a".repeat(64))).resolves.toBe(true);
    await repository.discardUnpreparedRequest("b".repeat(64));

    expect(String(query.mock.calls[0]![0])).toContain("ON CONFLICT (owner_address) DO NOTHING");
    expect(String(query.mock.calls[0]![0])).toContain("e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')");
    expect(String(query.mock.calls[1]![0])).toContain("state = 'RECEIVED'");
    expect(String(query.mock.calls[1]![0])).toContain("NOT EXISTS");
  });

  it("does not release an address claim while paid activity or a lease is unresolved", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    const repository = new GatewayRepository({ query } as never);

    await repository.releaseAddressClaim("TAddress", "a".repeat(64));

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')");
    expect(sql).toContain("l.state NOT IN ('RELEASED', 'FAILED', 'FAILED_NO_DELEGATION')");
  });

  it("cleans up only claims whose requests are already terminal", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    const repository = new GatewayRepository({ query } as never);

    await expect(repository.releaseTerminalAddressClaims()).resolves.toBe(2);

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("USING broadcast_requests");
    expect(sql).toContain("SOLIDIFIED_SUCCESS");
    expect(sql).not.toContain("UPSTREAM_ACCEPTED'");
    expect(sql).toContain("e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')");
    expect(sql).toContain("l.state NOT IN ('RELEASED', 'FAILED', 'FAILED_NO_DELEGATION')");
  });
});

describe("GatewayRepository resource audit", () => {
  const txId = "d".repeat(64);

  it("persists a typed preflight plan without embedding an opaque payload", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const repository = new GatewayRepository({ query } as never);

    await repository.upsertResourceAuditPlan(txId, {
      energyEstimateRaw: 72_321n,
      energyEstimateSafe: 83_170n,
      estimateSafetyBps: 11_500,
      energyAvailableBefore: 0n,
      packageThreshold: 100_000n,
      energyPackageQuoted: 65_000n,
      energyPriceSun: 100n,
      estimatedEnergyBurnSun: 1_817_000n,
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

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO transaction_resource_audits");
    expect(sql).toContain("ON CONFLICT (tx_id) DO UPDATE");
    expect(sql).not.toContain("JSONB");
    expect(parameters).toEqual([
      txId,
      "72321",
      "83170",
      11_500,
      "0",
      "100000",
      "65000",
      "100",
      "1817000",
      "401",
      "0",
      "334",
      "TRX",
      "1000",
      "67000",
      "121203304",
      "30000000",
      "8317000",
      "15000000000"
    ]);
  });

  it("records the exact package amount sent to a provider", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const repository = new GatewayRepository({ query } as never);

    await repository.recordEnergyPackageAttempt(txId, 65_000n);

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("energy_package_attempted");
    expect(sql).toContain("ON CONFLICT (tx_id) DO UPDATE");
    expect(parameters).toEqual([txId, "65000"]);
  });

  it("keeps the highest observed post-order energy for a stable arrival delta", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const repository = new GatewayRepository({ query } as never);

    await repository.recordEnergyArrival(txId, 65_000n);

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("EXCLUDED.energy_available_after > transaction_resource_audits.energy_available_after");
    expect(parameters).toEqual([txId, "65000"]);
  });

  it("records only whitelisted solidified receipt metrics in the finalization transaction", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query, release: vi.fn() };
    const repository = new GatewayRepository({ connect: vi.fn().mockResolvedValue(client) } as never);
    const receipt = {
      id: txId,
      fee: "2162000",
      result: "OUT_OF_ENERGY",
      contractResult: ["sensitive-contract-result-must-not-be-stored"],
      receipt: {
        energy_usage_total: "83170",
        energy_usage: 65_000,
        origin_energy_usage: 18_170,
        net_usage: 0,
        net_fee: "345000",
        energy_fee: "1817000"
      }
    };

    await repository.markFinalized(txId, false, 30_000, receipt);

    const auditCall = query.mock.calls.find((call) =>
      String(call[0]).includes("receipt_energy_usage_total")
    ) as unknown as [string, unknown[]] | undefined;
    expect(auditCall).toBeDefined();
    expect(auditCall?.[1]).toEqual([
      txId,
      "83170",
      "65000",
      "18170",
      "0",
      "345000",
      "1817000",
      "2162000",
      "OUT_OF_ENERGY"
    ]);
    expect(JSON.stringify(auditCall)).not.toContain("sensitive-contract-result");
    expect(query.mock.calls.map((call) => String(call[0]))).toEqual([
      "BEGIN",
      expect.stringContaining("UPDATE broadcast_requests"),
      expect.stringContaining("INSERT INTO transaction_resource_audits"),
      expect.stringContaining("UPDATE resource_leases"),
      expect.stringContaining("DELETE FROM sponsor_address_claims"),
      "COMMIT"
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("uses protobuf zero defaults but rejects unsafe numeric receipt values", () => {
    expect(summarizeSolidifiedReceipt({ receipt: {}, result: "SUCCESS" }, true)).toMatchObject({
      energyUsageTotal: 0n,
      netUsage: 0n,
      netFeeSun: 0n,
      energyFeeSun: 0n,
      totalFeeSun: 0n,
      result: "SUCCESS"
    });
    expect(summarizeSolidifiedReceipt({
      receipt: { energy_usage_total: Number.MAX_SAFE_INTEGER + 1 },
      result: "bad result with spaces"
    }, false)).toMatchObject({
      energyUsageTotal: null,
      result: "BAD_RESULT_WITH_SPACES"
    });
  });
});
