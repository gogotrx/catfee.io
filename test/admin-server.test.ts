import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminServer, type AdminRuntimeConfig } from "../src/admin-server.js";
import type { TronNodeApi } from "../src/node-api.js";
import type { EnergyProviderRepository } from "../src/providers/repository.js";
import type { EnergyProviderService } from "../src/providers/service.js";
import { ProviderAccountQueryError } from "../src/providers/types.js";
import type { GatewayRepository } from "../src/repository.js";
import type { SignerClient } from "../src/signer-client.js";

const token = "admin-test-token-that-is-at-least-32-characters";
const runtime: AdminRuntimeConfig = {
  mode: "observe",
  gatewayPort: 50051,
  authMode: "bound_address",
  unsupportedPolicy: "reject",
  insufficientPolicy: "forward",
  sponsorEnergy: true,
  sponsorBandwidth: false,
  energySource: "provider",
  allowOwnerBandwidthBurn: true,
  maxOwnerBandwidthBurnSun: 1_000_000n,
  allowOwnerEnergyBurn: true,
  maxOwnerEnergyBurnSun: 5_000_000n,
  energyPackageThreshold: 100_000,
  providerMaxEnergyPerOrder: 200_000,
  providerDailyMaxOrders: 20,
  providerDailyMaxEnergy: 2_000_000,
  resourceOwnerAddress: "TResourceOwnerPublicAddress"
};

describe("admin HTTP API", () => {
  const servers: AdminServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("requires Bearer authentication for the status endpoint and returns only summarized runtime data", async () => {
    const repository = {
      getDashboardStats: vi.fn().mockResolvedValue({
        bindingsTotal: 3n,
        bindingsEnabled: 2n,
        requestsTotal: 12n,
        leasesTotal: 4n,
        requestsByState: { UPSTREAM_ACCEPTED: 7n, FAILED: 5n },
        leasesByState: { ACTIVE: 4n }
      })
    } as unknown as GatewayRepository;
    const node = {
      getNodeInfo: vi.fn().mockResolvedValue({
        block: "Num:100,ID:abc",
        solidityBlock: "Num:95,ID:def",
        currentConnectCount: 30,
        activeConnectCount: 8,
        configNodeInfo: {
          codeVersion: "GreatVoyage-v4.8.2.1",
          supportConstant: true
        },
        machineInfo: { memoryDescInfoList: ["must-not-leak"] },
        peerList: [{ host: "must-not-leak" }]
      }),
      getSolidityNowBlock: vi.fn().mockResolvedValue({ block_header: { raw_data: { number: 98 } } })
    } as unknown as TronNodeApi;
    const signer = { health: vi.fn().mockResolvedValue(true) } as unknown as SignerClient;
    const { server, baseUrl } = await start(repository, node, signer);
    servers.push(server);

    const unauthorized = await fetch(`${baseUrl}/v1/status`);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${baseUrl}/v1/status`, { headers: authorization() });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      gateway: {
        mode: "observe",
        grpcPort: 50051,
        authMode: "bound_address",
        policies: { unsupported: "reject", insufficientResources: "forward" },
        sponsorship: { energy: true, bandwidth: false, energySource: "provider" },
        resourceOwner: { configured: true, address: "TResourceOwnerPublicAddress" }
      },
      database: {
        reachable: true,
        stats: {
          bindingsTotal: "3",
          bindingsEnabled: "2",
          requestsTotal: "12",
          leasesTotal: "4",
          requestsByState: { UPSTREAM_ACCEPTED: "7", FAILED: "5" },
          leasesByState: { ACTIVE: "4" }
        }
      },
      nodes: {
        fullNode: {
          reachable: true,
          height: "100",
          solidHeight: "98",
          lag: "2",
          connections: { current: 30, active: 8 },
          version: "GreatVoyage-v4.8.2.1",
          supportConstant: true
        },
        solidityNode: { reachable: true, height: "98" }
      },
      signer: { reachable: true }
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("DATABASE_URL");
  });

  it("serves only fixed management assets with restrictive browser headers", async () => {
    const { server, baseUrl } = await start(
      {} as GatewayRepository,
      {} as TronNodeApi,
      {} as SignerClient
    );
    servers.push(server);

    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect((await response.text()).toLowerCase()).toContain("<!doctype html>");

    const traversal = await fetch(`${baseUrl}/package.json`);
    expect(traversal.status).toBe(401);
  });

  it("reports failed probes without failing the whole status request", async () => {
    const repository = {
      getDashboardStats: vi.fn().mockRejectedValue(new Error("database URL must not leak"))
    } as unknown as GatewayRepository;
    const node = {
      getNodeInfo: vi.fn().mockRejectedValue(new Error("full node failed")),
      getSolidityNowBlock: vi.fn().mockRejectedValue(new Error("solidity node failed"))
    } as unknown as TronNodeApi;
    const signer = { health: vi.fn().mockRejectedValue(new Error("signer token must not leak")) } as unknown as SignerClient;
    const { server, baseUrl } = await start(repository, node, signer);
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/status`, { headers: authorization() });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      database: { reachable: false, stats: null },
      nodes: {
        fullNode: { reachable: false, height: null, solidHeight: null, lag: null },
        solidityNode: { reachable: false, height: null }
      },
      signer: { reachable: false }
    });
    expect(JSON.stringify(payload)).not.toContain("must not leak");
  });

  it("lists recent requests with a bounded limit and serializes bigint values", async () => {
    const listRecentRequests = vi.fn().mockResolvedValue([
      {
        txId: "a".repeat(64),
        ownerAddress: "TOwner",
        contractType: 31,
        contractAddress: "TContract",
        functionSelector: "a9059cbb",
        expirationMs: 9_999_999_999_999n,
        state: "UPSTREAM_ACCEPTED",
        energyRequired: 71_999n,
        energyDeficit: 70_000n,
        bandwidthRequired: null,
        bandwidthDeficit: null,
        errorCode: null,
        audit: {
          energyEstimateRaw: 62_608n,
          energyEstimateSafe: 71_999n,
          bandwidthSource: "TRX",
          estimatedBandwidthBurnSun: 67_000n,
          receiptEnergyUsageTotal: 64_321n,
          receiptEnergyFeeSun: 0n,
          receiptResult: "SUCCESS",
          solidifiedAt: new Date("2026-09-10T00:00:02.000Z")
        },
        createdAt: new Date("2026-09-10T00:00:00.000Z"),
        updatedAt: new Date("2026-09-10T00:00:01.000Z")
      }
    ]);
    const repository = { listRecentRequests } as unknown as GatewayRepository;
    const { server, baseUrl } = await start(repository, {} as TronNodeApi, {} as SignerClient);
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/requests?limit=25`, { headers: authorization() });
    expect(response.status).toBe(200);
    expect(listRecentRequests).toHaveBeenCalledWith(25);
    expect(await response.json()).toMatchObject({
      requests: [
        {
          expirationMs: "9999999999999",
          energyRequired: "71999",
          energyDeficit: "70000",
          audit: {
            energyEstimateRaw: "62608",
            energyEstimateSafe: "71999",
            estimatedBandwidthBurnSun: "67000",
            receiptEnergyUsageTotal: "64321",
            receiptEnergyFeeSun: "0",
            receiptResult: "SUCCESS",
            solidifiedAt: "2026-09-10T00:00:02.000Z"
          },
          createdAt: "2026-09-10T00:00:00.000Z"
        }
      ]
    });
  });

  it("keeps omitted binding fields omitted and rejects an excessive transaction maximum", async () => {
    const binding = {
      address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      label: "new label",
      enabled: false,
      maxTransactions: 25n,
      usedTransactions: 2n,
      reservedTransactions: 0n,
      expiresAt: null
    };
    const upsertBinding = vi.fn().mockResolvedValue(binding);
    const repository = { upsertBinding } as unknown as GatewayRepository;
    const { server, baseUrl } = await start(repository, {} as TronNodeApi, {} as SignerClient);
    servers.push(server);

    const partialResponse = await fetch(`${baseUrl}/v1/bindings`, {
      method: "POST",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({ address: binding.address, label: "new label" })
    });
    expect(partialResponse.status).toBe(200);
    expect(upsertBinding).toHaveBeenCalledWith({ address: binding.address, label: "new label" });

    const excessiveResponse = await fetch(`${baseUrl}/v1/bindings`, {
      method: "POST",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({ address: binding.address, maxTransactions: 1_000_001 })
    });
    expect(excessiveResponse.status).toBe(400);
    expect(upsertBinding).toHaveBeenCalledTimes(1);
  });

  it("manages encrypted provider records without returning or logging the API key", async () => {
    const publicProvider = {
      id: 7n,
      type: "kuaizu",
      name: "快租主账号",
      enabled: true,
      priority: 10,
      rentTime: 15 as const,
      apiKeyConfigured: true,
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
      updatedAt: new Date("2026-09-10T00:00:00.000Z")
    };
    const energyProviders = {
      listProviders: vi.fn().mockResolvedValue([publicProvider]),
      createProvider: vi.fn().mockResolvedValue(publicProvider),
      updateProvider: vi.fn().mockResolvedValue(publicProvider)
    } as unknown as EnergyProviderRepository;
    const { server, baseUrl } = await start(
      {} as GatewayRepository,
      {} as TronNodeApi,
      {} as SignerClient,
      energyProviders
    );
    servers.push(server);

    const secret = "kuaizu-test-key-that-must-never-be-returned";
    const create = await fetch(`${baseUrl}/v1/providers`, {
      method: "POST",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({
        type: "kuaizu",
        name: "快租主账号",
        apiKey: secret,
        enabled: false,
        priority: 10,
        rentTime: 15
      })
    });
    expect(create.status).toBe(201);
    expect(JSON.stringify(await create.json())).not.toContain(secret);
    expect(energyProviders.createProvider).toHaveBeenCalledWith({
      type: "kuaizu",
      name: "快租主账号",
      apiKey: secret,
      enabled: false,
      priority: 10,
      rentTime: 15
    });

    const update = await fetch(`${baseUrl}/v1/providers/7`, {
      method: "PATCH",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({ priority: 20 })
    });
    expect(update.status).toBe(200);
    expect(energyProviders.updateProvider).toHaveBeenCalledWith(7n, { priority: 20 });
  });

  it("requires provider creation and activation to be two separate reviewed actions", async () => {
    const energyProviders = { createProvider: vi.fn() } as unknown as EnergyProviderRepository;
    const { server, baseUrl } = await start(
      {} as GatewayRepository,
      {} as TronNodeApi,
      {} as SignerClient,
      energyProviders
    );
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/providers`, {
      method: "POST",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({
        type: "kuaizu",
        name: "must-review",
        apiKey: "secret-key",
        enabled: true,
        rentTime: 15
      })
    });
    expect(response.status).toBe(400);
    expect(energyProviders.createProvider).not.toHaveBeenCalled();
  });

  it("queries a provider account through the authenticated server without returning credentials", async () => {
    const accountQuery = {
      queryAccountSnapshot: vi.fn().mockResolvedValue({
        providerId: 7n,
        providerType: "kuaizu",
        balanceTrx: "113.233",
        priceSunPerEnergy: "30",
        packages: [
          { energy: 65_000, estimatedCostTrx: "1.95" },
          { energy: 131_000, estimatedCostTrx: "3.93" }
        ],
        checkedAt: new Date("2026-09-10T08:00:00.000Z")
      })
    } as unknown as Pick<EnergyProviderService, "queryAccountSnapshot">;
    const { server, baseUrl } = await start(
      {} as GatewayRepository,
      {} as TronNodeApi,
      {} as SignerClient,
      undefined,
      runtime,
      accountQuery
    );
    servers.push(server);

    const unauthorized = await fetch(`${baseUrl}/v1/providers/7/account-snapshot`, {
      method: "POST"
    });
    expect(unauthorized.status).toBe(401);
    expect(accountQuery.queryAccountSnapshot).not.toHaveBeenCalled();

    const response = await fetch(`${baseUrl}/v1/providers/7/account-snapshot`, {
      method: "POST",
      headers: authorization()
    });

    expect(response.status).toBe(200);
    expect(accountQuery.queryAccountSnapshot).toHaveBeenCalledWith(7n);
    const payload = await response.json();
    expect(payload).toMatchObject({
      providerId: "7",
      providerType: "kuaizu",
      balanceTrx: "113.233",
      priceSunPerEnergy: "30",
      packages: [
        { energy: 65_000, estimatedCostTrx: "1.95" },
        { energy: 131_000, estimatedCostTrx: "3.93" }
      ],
      checkedAt: "2026-09-10T08:00:00.000Z"
    });
    expect(JSON.stringify(payload)).not.toContain("apiKey");
  });

  it("returns a stable sanitized error when the provider balance endpoint is unavailable", async () => {
    const accountQuery = {
      queryAccountSnapshot: vi.fn().mockRejectedValue(
        new ProviderAccountQueryError("KUAIZU_BALANCE_NETWORK_ERROR")
      )
    } as unknown as Pick<EnergyProviderService, "queryAccountSnapshot">;
    const { server, baseUrl } = await start(
      {} as GatewayRepository,
      {} as TronNodeApi,
      {} as SignerClient,
      undefined,
      runtime,
      accountQuery
    );
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/providers/7/account-snapshot`, {
      method: "POST",
      headers: authorization()
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider_account_unavailable" });
  });

  it("requires an enabled provider to be disabled before paid settings can change", async () => {
    const updateProvider = vi.fn();
    const energyProviders = {
      getProvider: vi.fn().mockResolvedValue({
        id: 7n,
        enabled: true,
        apiKeyConfigured: true
      }),
      updateProvider
    } as unknown as EnergyProviderRepository;
    const { server, baseUrl } = await start(
      {} as GatewayRepository,
      {} as TronNodeApi,
      {} as SignerClient,
      energyProviders
    );
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/providers/7`, {
      method: "PATCH",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({ rentTime: 1 })
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "provider_must_be_disabled" });
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("returns a sanitized provider order summary", async () => {
    const energyProviders = {
      listRecentOrders: vi.fn().mockResolvedValue([
        {
          id: 3n,
          txId: "b".repeat(64),
          providerId: 7n,
          receiveAddress: "TReceiver",
          requestedAmount: 82_799,
          amount: 131_000,
          rentTime: 15,
          state: "UNKNOWN",
          providerOrderId: null,
          providerBalanceTrx: null,
          orderCostTrx: null,
          delegationTxHash: null,
          senderAddresses: [],
          failureCode: "KUAIZU_NETWORK_AMBIGUOUS",
          failureMessage: "internal provider detail must not be returned",
          attempts: [{
            state: "ORDERING",
            providerId: "7",
            providerType: "kuaizu",
            requestedAmount: 82_799,
            orderedAmount: 131_000,
            code: null,
            at: "2026-09-10T00:00:00.000Z",
            secret: "must-not-leak"
          }],
          createdAt: new Date("2026-09-10T00:00:00.000Z"),
          updatedAt: new Date("2026-09-10T00:00:01.000Z")
        }
      ])
    } as unknown as EnergyProviderRepository;
    const { server, baseUrl } = await start(
      {} as GatewayRepository,
      {} as TronNodeApi,
      {} as SignerClient,
      energyProviders
    );
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/provider-orders?limit=20`, {
      headers: authorization()
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { orders: Array<Record<string, unknown>> };
    expect(payload.orders[0]).toMatchObject({
      requestedAmount: 82_799,
      orderedAmount: 131_000,
      amount: 131_000,
      attempts: [{
        state: "ORDERING",
        providerType: "kuaizu",
        requestedAmount: 82_799,
        orderedAmount: 131_000
      }]
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("KUAIZU_NETWORK_AMBIGUOUS");
    expect(serialized).not.toContain("internal provider detail");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("requires JSON content type for management mutations", async () => {
    const repository = { upsertBinding: vi.fn() } as unknown as GatewayRepository;
    const { server, baseUrl } = await start(repository, {} as TronNodeApi, {} as SignerClient);
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/bindings`, {
      method: "POST",
      headers: authorization(),
      body: JSON.stringify({ address: "TAddress" })
    });
    expect(response.status).toBe(415);
    expect(repository.upsertBinding).not.toHaveBeenCalled();
  });

  it("requires a finite address quota in paid-provider sponsor mode", async () => {
    const repository = {
      getBinding: vi.fn().mockResolvedValue(null),
      upsertBinding: vi.fn()
    } as unknown as GatewayRepository;
    const { server, baseUrl } = await start(
      repository,
      {} as TronNodeApi,
      {} as SignerClient,
      undefined,
      { ...runtime, mode: "sponsor", insufficientPolicy: "reject" }
    );
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/bindings`, {
      method: "POST",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({
        address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        maxTransactions: null
      })
    });

    expect(response.status).toBe(400);
    expect(repository.upsertBinding).not.toHaveBeenCalled();
  });

  it("uses stable service-unavailable codes for readiness and missing provider storage", async () => {
    const repository = { ping: vi.fn().mockRejectedValue(new Error("database unavailable")) } as unknown as GatewayRepository;
    const { server, baseUrl } = await start(repository, {} as TronNodeApi, {} as SignerClient);
    servers.push(server);

    const ready = await fetch(`${baseUrl}/readyz`, { headers: authorization() });
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ error: "not_ready" });

    const providers = await fetch(`${baseUrl}/v1/providers`, { headers: authorization() });
    expect(providers.status).toBe(503);
    expect(await providers.json()).toEqual({ error: "provider_storage_unavailable" });
  });

  it("maps provider name conflicts to HTTP 409 without exposing database details", async () => {
    const conflict = Object.assign(new Error("sensitive database detail"), { code: "23505" });
    const energyProviders = {
      createProvider: vi.fn().mockRejectedValue(conflict)
    } as unknown as EnergyProviderRepository;
    const { server, baseUrl } = await start(
      {} as GatewayRepository,
      {} as TronNodeApi,
      {} as SignerClient,
      energyProviders
    );
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/providers`, {
      method: "POST",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({
        type: "kuaizu",
        name: "duplicate",
        apiKey: "secret-key",
        rentTime: 15
      })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
  });

  it("distinguishes a missing binding from active reservations during reset", async () => {
    const getBinding = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" });
    const resetBindingUsage = vi.fn().mockResolvedValue(null);
    const repository = { getBinding, resetBindingUsage } as unknown as GatewayRepository;
    const { server, baseUrl } = await start(repository, {} as TronNodeApi, {} as SignerClient);
    servers.push(server);
    const request = () => fetch(
      `${baseUrl}/v1/bindings/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/reset`,
      {
        method: "POST",
        headers: { ...authorization(), "content-type": "application/json" },
        body: "{}"
      }
    );

    const missing = await request();
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    const active = await request();
    expect(active.status).toBe(409);
    expect(await active.json()).toEqual({ error: "active_reservations" });
  });

  it("blocks quota reset while a paid provider order still needs reconciliation", async () => {
    const repository = {
      getBinding: vi.fn().mockResolvedValue({ address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }),
      hasOpenPaidProviderActivity: vi.fn().mockResolvedValue(true),
      resetBindingUsage: vi.fn()
    } as unknown as GatewayRepository;
    const { server, baseUrl } = await start(
      repository,
      {} as TronNodeApi,
      {} as SignerClient,
      undefined,
      { ...runtime, mode: "sponsor", insufficientPolicy: "reject" }
    );
    servers.push(server);

    const response = await fetch(
      `${baseUrl}/v1/bindings/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/reset`,
      {
        method: "POST",
        headers: { ...authorization(), "content-type": "application/json" },
        body: "{}"
      }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "unresolved_provider_order" });
    expect(repository.resetBindingUsage).not.toHaveBeenCalled();
  });

  it("reports an unresolved paid order created during the atomic reset check", async () => {
    const address = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const repository = {
      getBinding: vi.fn().mockResolvedValue({ address }),
      hasOpenPaidProviderActivity: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      resetBindingUsage: vi.fn().mockResolvedValue(null)
    } as unknown as GatewayRepository;
    const { server, baseUrl } = await start(
      repository,
      {} as TronNodeApi,
      {} as SignerClient,
      undefined,
      { ...runtime, mode: "sponsor", insufficientPolicy: "reject" }
    );
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/bindings/${address}/reset`, {
      method: "POST",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({ maxTransactions: 1 })
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "unresolved_provider_order" });
    expect(repository.resetBindingUsage).toHaveBeenCalledWith(address, 1n, true);
  });

  it("rejects malformed percent encoding in a binding path", async () => {
    const repository = { setBindingEnabled: vi.fn() } as unknown as GatewayRepository;
    const { server, baseUrl } = await start(repository, {} as TronNodeApi, {} as SignerClient);
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/bindings/%ZZ`, {
      method: "PATCH",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    expect(response.status).toBe(400);
    expect(repository.setBindingEnabled).not.toHaveBeenCalled();
  });

  it.each(["0", "201", "1.5", "01", "1&limit=2", "1&extra=true"])(
    "rejects invalid request-list query %s",
    async (query) => {
      const listRecentRequests = vi.fn();
      const repository = { listRecentRequests } as unknown as GatewayRepository;
      const { server, baseUrl } = await start(repository, {} as TronNodeApi, {} as SignerClient);
      servers.push(server);

      const response = await fetch(`${baseUrl}/v1/requests?limit=${query}`, { headers: authorization() });
      expect(response.status).toBe(400);
      expect(listRecentRequests).not.toHaveBeenCalled();
    }
  );
});

function authorization(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function start(
  repository: GatewayRepository,
  node: TronNodeApi,
  signer: SignerClient,
  energyProviders?: EnergyProviderRepository,
  runtimeOverride: AdminRuntimeConfig = runtime,
  energyProviderService?: Pick<EnergyProviderService, "queryAccountSnapshot">
) {
  const server = new AdminServer(
    "127.0.0.1",
    0,
    token,
    repository,
    node,
    runtimeOverride,
    signer,
    energyProviders,
    undefined,
    energyProviderService
  );
  await server.listen();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Admin server did not bind a TCP port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
