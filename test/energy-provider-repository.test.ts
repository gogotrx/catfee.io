import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProviderSecretCipher } from "../src/providers/crypto.js";
import { EnergyProviderRepository } from "../src/providers/repository.js";

const utcDay = "2026-09-10";

describe("EnergyProviderRepository", () => {
  it("stores encrypted API key material, safe per-provider defaults, and starts disabled", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [providerRow()] });
    const repository = new EnergyProviderRepository({ query } as never, cipher());
    const apiKey = "plaintext-api-key-must-not-be-stored";

    const provider = await repository.createProvider({
      type: "kuaizu",
      name: "快租主账户",
      apiKey,
      priority: 10,
      rentTime: 1
    });

    expect(provider).toMatchObject({
      apiKeyConfigured: true,
      maxEnergyPerOrder: 131_000,
      dailyOrderLimit: 10,
      dailyEnergyLimit: 1_000_000
    });
    expect(provider).not.toHaveProperty("apiKey");
    const parameters = query.mock.calls[0]![1] as unknown[];
    expect(parameters).not.toContain(apiKey);
    expect(parameters[2]).toBe(false);
    expect(parameters.slice(5, 8)).toEqual([131_000, 10, 1_000_000]);
    expect(parameters[8]).toEqual(expect.any(String));
    expect(parameters[9]).toBeInstanceOf(Buffer);
    expect((parameters[9] as Buffer).toString("utf8")).not.toContain(apiKey);
  });

  it("requests enabled providers in deterministic priority order", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new EnergyProviderRepository({ query } as never, cipher());

    await repository.listEnabledProviders();

    expect(String(query.mock.calls[0]![0])).toContain("ORDER BY priority ASC, id ASC");
  });

  it("decrypts one provider credential only for a server-side account query", async () => {
    const secretCipher = cipher();
    const credentialId = "994f9d6e-8290-47a2-9332-7338f6ab3e30";
    const apiKey = "account-query-key";
    const row = {
      ...providerRow("9"),
      credential_id: credentialId,
      credential_version: 3,
      api_key_encrypted: secretCipher.encrypt(apiKey, {
        providerType: "kuaizu",
        credentialId,
        version: 3
      })
    };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const repository = new EnergyProviderRepository({ query } as never, secretCipher);

    const credential = await repository.getProviderCredential(9n);

    expect(credential).toMatchObject({ id: 9n, type: "kuaizu", apiKey });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("api_key_encrypted"), ["9"]);
  });

  it("uses an insert conflict as the transaction-id deduplication boundary", async () => {
    const row = orderRow();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const repository = new EnergyProviderRepository({ query } as never, cipher());

    const result = await repository.beginOrder({
      txId: "a".repeat(64),
      receiveAddress: row.receive_address,
      amount: 65_000
    });

    expect(result.kind).toBe("existing");
    expect(String(query.mock.calls[0]![0])).toContain("ON CONFLICT (tx_id) DO NOTHING");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("uses the post-lock wall-clock UTC day for both budget check and reservation", async () => {
    const secretCipher = cipher();
    const client = successfulStartClient(secretCipher, 7n, 9n);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    const repository = new EnergyProviderRepository(pool as never, secretCipher);

    const result = await repository.startAttempt(7n, 9n, 65_000);

    expect(result?.provider.apiKey).toBe("one-provider-key");
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(sql[1]).toContain("pg_advisory_xact_lock");
    expect(sql[2]).toContain("FOR UPDATE OF o, p");
    expect(sql[2]).toContain("clock_timestamp()");
    expect(sql[2]).not.toContain("CURRENT_TIMESTAMP");
    expect(sql[3]).toContain("FROM energy_provider_budget_ledger");
    expect(sql[4]).toContain("INSERT INTO energy_provider_budget_ledger");
    expect(sql[5]).toContain("UPDATE energy_provider_orders");
    expect(sql[6]).toBe("COMMIT");
    expect(client.query.mock.calls[3]![1]).toEqual([utcDay, "9"]);
    expect(client.query.mock.calls[4]![1]).toEqual([utcDay, "7", "9", "65000"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("reserves the actual provider package while retaining the requested amount", async () => {
    const secretCipher = cipher();
    const client = startClient(
      secretCipher,
      7n,
      9n,
      {
        global_orders: "0",
        global_energy: "0",
        provider_orders: "0",
        provider_energy: "0"
      },
      "83170",
      "131000"
    );
    const repository = new EnergyProviderRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      secretCipher
    );

    const result = await repository.startAttempt(7n, 9n, 131_000);

    expect(result?.order).toMatchObject({ requestedAmount: 83_170, amount: 131_000 });
    expect(client.query.mock.calls[4]![1]).toEqual([utcDay, "7", "9", "131000"]);
  });

  it("gives concurrent attempts separate clients and the same serialized lock boundary", async () => {
    const secretCipher = cipher();
    const first = successfulStartClient(secretCipher, 7n, 9n);
    const second = successfulStartClient(secretCipher, 8n, 10n);
    const pool = {
      connect: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
    };
    const repository = new EnergyProviderRepository(pool as never, secretCipher);

    const results = await Promise.all([
      repository.startAttempt(7n, 9n, 65_000),
      repository.startAttempt(8n, 10n, 65_000)
    ]);

    expect(results.every((result) => result?.order.state === "ORDERING")).toBe(true);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    for (const client of [first, second]) {
      expect(String(client.query.mock.calls[1]![0])).toContain("pg_advisory_xact_lock");
      expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  it("allows only one concurrent reservation when one global order slot remains", async () => {
    const secretCipher = cipher();
    const first = successfulStartClient(secretCipher, 7n, 9n);
    const second = startClient(secretCipher, 8n, 10n, {
      global_orders: "1",
      global_energy: "65000",
      provider_orders: "0",
      provider_energy: "0"
    });
    let unlockSecond!: () => void;
    const firstCommitted = new Promise<void>((resolve) => {
      unlockSecond = resolve;
    });
    const events: string[] = [];
    const firstQuery = first.query;
    first.query = vi.fn(async (sql: unknown, parameters?: unknown[]) => {
      const statement = String(sql);
      const result = await firstQuery(sql, parameters);
      if (statement === "COMMIT") {
        events.push("first-commit");
        unlockSecond();
      }
      return result;
    });
    const secondQuery = second.query;
    second.query = vi.fn(async (sql: unknown, parameters?: unknown[]) => {
      const statement = String(sql);
      if (statement.includes("pg_advisory_xact_lock")) {
        events.push("second-waits-for-lock");
        await firstCommitted;
        events.push("second-acquires-lock");
      }
      if (statement.includes("FOR UPDATE OF o, p")) events.push("second-fresh-snapshot");
      return secondQuery(sql, parameters);
    });
    const repository = new EnergyProviderRepository(
      {
        connect: vi.fn()
          .mockResolvedValueOnce(first)
          .mockResolvedValueOnce(second)
      } as never,
      secretCipher,
      {
        maxEnergyPerOrder: 200_000,
        dailyOrderLimit: 1,
        dailyEnergyLimit: 1_000_000
      }
    );

    const [firstResult, secondResult] = await Promise.all([
      repository.startAttempt(7n, 9n, 65_000),
      repository.startAttempt(8n, 10n, 65_000)
    ]);

    expect(firstResult?.order.state).toBe("ORDERING");
    expect(secondResult).toBeNull();
    expect(events).toEqual([
      "second-waits-for-lock",
      "first-commit",
      "second-acquires-lock",
      "second-fresh-snapshot"
    ]);
    expect(String(second.query.mock.calls.at(-1)?.[0])).toBe("ROLLBACK");
  });

  it("refuses a reservation when either global or provider daily budget is exhausted", async () => {
    const secretCipher = cipher();
    const client = startClient(secretCipher, 7n, 9n, {
      global_orders: "10",
      global_energy: "650000",
      provider_orders: "10",
      provider_energy: "650000"
    });
    const repository = new EnergyProviderRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      secretCipher
    );

    await expect(repository.startAttempt(7n, 9n, 65_000)).resolves.toBeNull();

    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO energy_provider_budget_ledger"))).toBe(false);
    expect(sql.at(-1)).toBe("ROLLBACK");
  });

  it("enforces a provider budget even when global capacity remains", async () => {
    const secretCipher = cipher();
    const client = startClient(secretCipher, 7n, 9n, {
      global_orders: "1",
      global_energy: "65000",
      provider_orders: "10",
      provider_energy: "650000"
    });
    const repository = new EnergyProviderRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      secretCipher,
      {
        maxEnergyPerOrder: 300_000,
        dailyOrderLimit: 100,
        dailyEnergyLimit: 10_000_000
      }
    );

    await expect(repository.startAttempt(7n, 9n, 65_000)).resolves.toBeNull();

    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((statement) => statement.includes("INSERT INTO energy_provider_budget_ledger"))).toBe(false);
    expect(sql.at(-1)).toBe("ROLLBACK");
  });

  it("rejects invalid provider limits before encrypting or writing", async () => {
    const query = vi.fn();
    const repository = new EnergyProviderRepository({ query } as never, cipher());

    await expect(repository.createProvider({
      type: "kuaizu",
      name: "invalid-budget",
      apiKey: "must-not-be-used",
      rentTime: 1,
      maxEnergyPerOrder: 131_000,
      dailyEnergyLimit: 100_000
    })).rejects.toThrow("dailyEnergyLimit must be at least maxEnergyPerOrder");

    expect(query).not.toHaveBeenCalled();
  });

  it("validates a partial provider-limit update against stored limits", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        provider_type: "kuaizu",
        credential_id: "994f9d6e-8290-47a2-9332-7338f6ab3e30",
        credential_version: 3,
        max_energy_per_order: "131000",
        daily_order_limit: "10",
        daily_energy_limit: "1000000"
      }]
    });
    const repository = new EnergyProviderRepository({ query } as never, cipher());

    await expect(repository.updateProvider(9n, {
      maxEnergyPerOrder: 2_000_000
    })).rejects.toThrow("Kuaizu maxEnergyPerOrder cannot exceed the 131000 ENERGY package");

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("enforces the disabled-provider paid-settings gate in the atomic UPDATE", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          provider_type: "kuaizu",
          credential_id: "994f9d6e-8290-47a2-9332-7338f6ab3e30",
          credential_version: 3,
        max_energy_per_order: "131000",
          daily_order_limit: "10",
          daily_energy_limit: "1000000"
        }]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...providerRow(), enabled: true }] });
    const repository = new EnergyProviderRepository({ query } as never, cipher());

    await expect(repository.updateProvider(9n, { rentTime: 15 })).rejects.toMatchObject({
      name: "ProviderMustBeDisabledError"
    });

    const [sql, parameters] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sql).toContain("NOT $20::boolean OR enabled = FALSE");
    expect(parameters[19]).toBe(true);
  });

  it.each([
    ["markRejected", "RELEASED", "REJECTED"],
    ["markUnknown", "CHARGED", "UNKNOWN"]
  ] as const)("%s atomically transitions its reservation to %s", async (method, ledgerState, orderState) => {
    const client = transitionClient(orderState);
    const repository = new EnergyProviderRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      cipher()
    );

    await repository[method](10n, publicProvider(), method === "markRejected" ? "DECLINED" : "TIMEOUT");

    expect(String(client.query.mock.calls[1]![0])).toContain("pg_advisory_xact_lock");
    expect(String(client.query.mock.calls[3]![0])).toContain("energy_provider_budget_ledger");
    expect(client.query.mock.calls[3]![1]).toEqual(["10", "9", ledgerState]);
    expect(client.query.mock.calls[4]![0]).toBe("COMMIT");
  });

  it("atomically charges the reservation when the provider accepts", async () => {
    const client = transitionClient("ACCEPTED");
    const repository = new EnergyProviderRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      cipher()
    );

    await repository.markAccepted(10n, { ...publicProvider(), apiKey: "secret" }, {
      kind: "accepted",
      providerOrderId: "123",
      providerBalanceTrx: "8",
      orderCostTrx: "2",
      delegationTxHash: "b".repeat(64),
      senderAddresses: ["T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"]
    });

    expect(client.query.mock.calls[3]![1]).toEqual(["10", "9", "CHARGED"]);
  });

  it("charges every interrupted reservation before marking ORDERING rows UNKNOWN", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    const repository = new EnergyProviderRepository(pool as never, cipher());

    await expect(repository.recoverInterruptedOrders()).resolves.toBe(2);

    const sql = client.query.mock.calls.map((call) => String(call[0]));
    expect(sql).toHaveLength(5);
    expect(sql[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(sql[1]).toContain("pg_advisory_xact_lock");
    expect(sql[2]).toContain("energy_provider_budget_ledger");
    expect(sql[2]).toContain("state = 'CHARGED'");
    expect(sql[3]).toContain("state = 'UNKNOWN'");
    expect(sql[4]).toBe("COMMIT");
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("reports global and per-provider usage from immutable UTC ledger entries", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ utc_day: utcDay }] })
      .mockResolvedValueOnce({ rows: [{
        ...providerRow(),
        reserved_orders: "1",
        reserved_energy: "65000",
        charged_orders: "2",
        charged_energy: "130000",
        released_orders: "3",
        released_energy: "195000"
      }] });
    const repository = new EnergyProviderRepository({ query } as never, cipher(), {
      maxEnergyPerOrder: 300_000,
      dailyOrderLimit: 20,
      dailyEnergyLimit: 2_000_000
    });

    const status = await repository.getBudgetStatus();

    expect(status).toMatchObject({
      window: "UTC_DAY",
      utcDay,
      usedOrders: 3n,
      usedEnergy: 195000n,
      remainingOrders: 17n,
      remainingEnergy: 1_805_000n
    });
    expect(status.providers[0]).toMatchObject({
      providerId: 9n,
      usedOrders: 3n,
      usedEnergy: 195000n,
      releasedOrders: 3n,
      remainingOrders: 7n,
      remainingEnergy: 805000n
    });
    expect(String(query.mock.calls[1]![0])).toContain("l.utc_day = $1::date");
    expect(String(query.mock.calls[1]![0])).not.toContain("energy_provider_orders.created_at");
  });
});

function cipher(): ProviderSecretCipher {
  return ProviderSecretCipher.fromEncodedKey(randomBytes(32).toString("hex"));
}

function providerRow(id = "9") {
  const now = new Date("2026-09-10T00:00:00.000Z");
  return {
    id,
    provider_type: "kuaizu",
    name: "快租主账户",
    enabled: true,
    priority: 10,
    rent_time: 1,
    max_energy_per_order: "131000",
    daily_order_limit: "10",
    daily_energy_limit: "1000000",
    api_key_configured: true,
    created_at: now,
    updated_at: now
  };
}

function publicProvider() {
  const row = providerRow();
  return {
    id: 9n,
    type: row.provider_type,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    rentTime: row.rent_time as 1,
    maxEnergyPerOrder: 131_000,
    dailyOrderLimit: 10,
    dailyEnergyLimit: 1_000_000,
    apiKeyConfigured: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function successfulStartClient(secretCipher: ProviderSecretCipher, orderId: bigint, providerId: bigint) {
  return startClient(secretCipher, orderId, providerId, {
    global_orders: "0",
    global_energy: "0",
    provider_orders: "0",
    provider_energy: "0"
  });
}

function startClient(
  secretCipher: ProviderSecretCipher,
  orderId: bigint,
  providerId: bigint,
  usage: { global_orders: string; global_energy: string; provider_orders: string; provider_energy: string },
  requestedEnergyAmount = "65000",
  orderedEnergyAmount = "65000"
) {
  const credentialId = providerId === 9n
    ? "994f9d6e-8290-47a2-9332-7338f6ab3e30"
    : "dd6ed23e-0cf7-4b9a-827c-963856471e3f";
  const encrypted = secretCipher.encrypt("one-provider-key", {
    providerType: "kuaizu",
    credentialId,
    version: 3
  });
  const snapshot = {
    ...providerRow(providerId.toString()),
    credential_id: credentialId,
    credential_version: 3,
    api_key_encrypted: encrypted,
    order_state: "PENDING",
    order_requested_energy_amount: requestedEnergyAmount,
    utc_day: utcDay,
    already_attempted: false
  };
  const ordered = {
    ...orderRow(orderId.toString()),
    provider_id: providerId.toString(),
    requested_energy_amount: requestedEnergyAmount,
    energy_amount: orderedEnergyAmount,
    rent_time: 1,
    state: "ORDERING"
  };
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [snapshot] })
    .mockResolvedValueOnce({ rows: [usage] })
    .mockResolvedValueOnce({ rows: [{ id: "1" }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [ordered], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [] });
  return { query, release: vi.fn() };
}

function transitionClient(state: string) {
  const transitioned = {
    ...orderRow("10"),
    provider_id: "9",
    rent_time: 1,
    state
  };
  return {
    query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [transitioned], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] }),
    release: vi.fn()
  };
}

function orderRow(id = "7") {
  const now = new Date("2026-09-10T00:00:00.000Z");
  return {
    id,
    tx_id: "a".repeat(64),
    provider_id: null,
    receive_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    requested_energy_amount: "65000",
    energy_amount: "65000",
    rent_time: null,
    state: "PENDING",
    provider_order_id: null,
    provider_balance_trx: null,
    order_cost_trx: null,
    delegation_tx_hash: null,
    sender_addresses: null,
    failure_code: null,
    failure_message: null,
    attempts: [],
    created_at: now,
    updated_at: now
  };
}
