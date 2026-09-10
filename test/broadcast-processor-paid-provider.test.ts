import { createHash } from "node:crypto";
import { computeAddress, SigningKey } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { BroadcastProcessor } from "../src/broadcast-processor.js";
import type { AppConfig } from "../src/config.js";
import {
  BROADCAST_PATH,
  ContractType,
  GatewayError,
  ReturnCode,
  type InspectedTransaction,
  type RawGrpcResponse
} from "../src/domain.js";
import { PaidProviderOrderError, type ResourceService } from "../src/resource-service.js";
import type { GatewayRepository } from "../src/repository.js";
import type { UpstreamGrpc } from "../src/grpc/upstream.js";
import { encodeUnaryGrpcFrame } from "../src/grpc/framing.js";
import { decodeReturnFrame, encodeReturnFrame } from "../src/grpc/protocol.js";
import { protocolTypes } from "../src/grpc/protocol.js";
import { tronBase58ToHex } from "../src/tron-address.js";

// Deterministic public test fixture. Never use this derived key for real funds.
const TEST_PRIVATE_KEY = `0x${createHash("sha256").update("tron-seamless-public-test-fixture").digest("hex")}`;
const MAINNET_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

describe("BroadcastProcessor paid provider cleanup", () => {
  it.each([
    { method: "GET", contentType: "application/grpc" },
    { method: "POST", contentType: "application/octet-stream" },
    { method: "POST", contentType: undefined }
  ])("rejects malformed sponsored transport before any paid work", async ({ method, contentType }) => {
    const repository = { beginRequest: vi.fn() };
    const resources = { calculateRequirements: vi.fn(), prepare: vi.fn() };
    const upstream = { unary: vi.fn() };
    const processor = new BroadcastProcessor(
      { mode: "sponsor" } as AppConfig,
      upstream as unknown as UpstreamGrpc,
      repository as unknown as GatewayRepository,
      resources as unknown as ResourceService
    );
    const headers = {
      ":method": method,
      ":path": BROADCAST_PATH,
      ...(contentType ? { "content-type": contentType } : {})
    };

    const response = await processor.handle(headers, Buffer.alloc(0));

    expect(decodeReturnFrame(response.body)).toMatchObject({
      result: false,
      code: ReturnCode.CONTRACT_VALIDATE_ERROR
    });
    expect(repository.beginRequest).not.toHaveBeenCalled();
    expect(resources.calculateRequirements).not.toHaveBeenCalled();
    expect(resources.prepare).not.toHaveBeenCalled();
    expect(upstream.unary).not.toHaveBeenCalled();
  });

  it("uses only the broadcast TTL floor after a paid provider has already delivered", () => {
    const processor = new BroadcastProcessor(
      {
        mode: "sponsor",
        energySource: "provider",
        minTransactionTtlMs: 15_000,
        maxTransactionTtlMs: 600_000,
        maxTransactionAgeMs: 120_000,
        maxTransactionFutureSkewMs: 30_000,
        providerOrderTimeoutMs: 10_000,
        providerConfirmTimeoutMs: 30_000,
        providerPollMs: 500
      } as unknown as AppConfig,
      {} as UpstreamGrpc,
      {} as GatewayRepository,
      {} as ResourceService
    );
    const validateLifetime = (processor as unknown as {
      validateLifetime(transaction: InspectedTransaction, phase: "entry" | "broadcast"): void;
    }).validateLifetime.bind(processor);
    const transaction = {
      expirationMs: BigInt(Date.now() + 20_000),
      timestampMs: BigInt(Date.now())
    } as InspectedTransaction;

    expect(() => validateLifetime(transaction, "entry")).toThrow(/too close to expiration/);
    expect(() => validateLifetime(transaction, "broadcast")).not.toThrow();
  });

  it("rejects an address missing from the binding database before any upstream broadcast", async () => {
    const repository = { getBinding: vi.fn().mockResolvedValue(null) };
    const upstream = { unary: vi.fn() };
    const processor = new BroadcastProcessor(
      { mode: "sponsor", authMode: "bound_address" } as AppConfig,
      upstream as unknown as UpstreamGrpc,
      repository as unknown as GatewayRepository,
      {} as ResourceService
    );
    const authorize = (processor as unknown as {
      authorize(transaction: InspectedTransaction, enforceInObserve: boolean): Promise<void>;
    }).authorize.bind(processor);

    await expect(authorize({ ownerAddress: "TUnbound" } as InspectedTransaction, false))
      .rejects.toMatchObject({ internalCode: "ADDRESS_NOT_BOUND" });
    expect(repository.getBinding).toHaveBeenCalledWith("TUnbound");
    expect(upstream.unary).not.toHaveBeenCalled();
  });

  it("rejects a fully signed unbound transaction before creating a request, reserving quota, or calling resources", async () => {
    const ethereum = computeAddress(TEST_PRIVATE_KEY);
    const ownerBytes = Buffer.from(`41${ethereum.slice(2)}`, "hex");
    const triggerBytes = protocolTypes.triggerType.encode(protocolTypes.triggerType.create({
      ownerAddress: ownerBytes,
      contractAddress: tronBase58ToHex(MAINNET_USDT),
      data: Buffer.from("a9059cbb" + "00".repeat(64), "hex")
    })).finish();
    const now = Date.now();
    const raw = protocolTypes.transactionRawType.create({
      refBlockBytes: Buffer.from("1234", "hex"),
      refBlockHash: Buffer.from("0102030405060708", "hex"),
      expiration: now + 60_000,
      timestamp: now,
      feeLimit: 100_000_000,
      contract: [{
        type: ContractType.TriggerSmartContract,
        parameter: {
          typeUrl: "type.googleapis.com/protocol.TriggerSmartContract",
          value: triggerBytes
        }
      }]
    });
    const rawBytes = Buffer.from(protocolTypes.transactionRawType.encode(raw).finish());
    const txId = createHash("sha256").update(rawBytes).digest("hex");
    const signature = Buffer.from(
      new SigningKey(TEST_PRIVATE_KEY).sign(`0x${txId}`).serialized.slice(2),
      "hex"
    );
    const transaction = protocolTypes.transactionType.create({ rawData: raw, signature: [signature] });
    const body = encodeUnaryGrpcFrame(protocolTypes.transactionType.encode(transaction).finish());
    const repository = {
      getBinding: vi.fn().mockResolvedValue(null),
      beginRequest: vi.fn(),
      reserveQuota: vi.fn()
    };
    const resources = { calculateRequirements: vi.fn(), prepare: vi.fn() };
    const upstream = { unary: vi.fn() };
    const processor = new BroadcastProcessor(
      {
        mode: "sponsor",
        authMode: "bound_address",
        energySource: "provider",
        sponsorEnergy: true,
        sponsorBandwidth: false,
        allowOwnerEnergyBurn: false,
        unsupportedPolicy: "reject",
        allowedContracts: new Set([MAINNET_USDT]),
        allowedSelectors: new Set(["a9059cbb"]),
        minTransactionTtlMs: 5_000,
        maxTransactionTtlMs: 600_000,
        maxTransactionAgeMs: 120_000,
        maxTransactionFutureSkewMs: 30_000,
        providerOrderTimeoutMs: 5_000,
        providerConfirmTimeoutMs: 10_000,
        providerPollMs: 250
      } as unknown as AppConfig,
      upstream as unknown as UpstreamGrpc,
      repository as unknown as GatewayRepository,
      resources as unknown as ResourceService
    );

    const response = await processor.handle({
      ":method": "POST",
      ":path": BROADCAST_PATH,
      "content-type": "application/grpc"
    }, body);

    expect(decodeReturnFrame(response.body)).toMatchObject({
      result: false,
      code: ReturnCode.CONTRACT_VALIDATE_ERROR,
      message: "Owner address is not enabled"
    });
    expect(repository.getBinding).toHaveBeenCalledTimes(1);
    expect(repository.beginRequest).not.toHaveBeenCalled();
    expect(repository.reserveQuota).not.toHaveBeenCalled();
    expect(resources.calculateRequirements).not.toHaveBeenCalled();
    expect(resources.prepare).not.toHaveBeenCalled();
    expect(upstream.unary).not.toHaveBeenCalled();
  });

  it("rejects stale timestamps and implausibly long expirations before paid preparation", () => {
    const config = {
      mode: "sponsor",
      energySource: "provider",
      minTransactionTtlMs: 15_000,
      maxTransactionTtlMs: 600_000,
      maxTransactionAgeMs: 120_000,
      maxTransactionFutureSkewMs: 30_000,
      providerOrderTimeoutMs: 10_000,
      providerConfirmTimeoutMs: 30_000,
      providerPollMs: 500
    } as AppConfig;
    const processor = new BroadcastProcessor(
      config,
      {} as UpstreamGrpc,
      {} as GatewayRepository,
      {} as ResourceService
    );
    const validateLifetime = (processor as unknown as {
      validateLifetime(transaction: InspectedTransaction, phase: "entry" | "broadcast"): void;
    }).validateLifetime.bind(processor);
    const now = Date.now();

    expect(() => validateLifetime({
      expirationMs: BigInt(now + 60_000),
      timestampMs: BigInt(now - 120_001)
    } as InspectedTransaction, "entry")).toThrow(/freshness/);
    expect(() => validateLifetime({
      expirationMs: BigInt(now + 610_000),
      timestampMs: BigInt(now)
    } as InspectedTransaction, "entry")).toThrow(/too far/);
  });

  it("consumes but never releases a reserved quota after a provider may have charged", async () => {
    const transaction = {
      txId: "a".repeat(64),
      ownerAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      expirationMs: BigInt(Date.now() + 120_000)
    } as InspectedTransaction;
    const consumeQuota = vi.fn().mockResolvedValue(undefined);
    const releaseQuota = vi.fn().mockResolvedValue(undefined);
    const releaseAddressClaim = vi.fn().mockResolvedValue(undefined);
    const repository = {
      beginRequest: vi.fn().mockResolvedValue({ kind: "created" }),
      tryAcquireAddressClaim: vi.fn().mockResolvedValue(true),
      reserveQuota: vi.fn().mockResolvedValue(true),
      updateRequirements: vi.fn().mockResolvedValue(undefined),
      setRequestState: vi.fn().mockResolvedValue(undefined),
      consumeQuota,
      releaseQuota,
      releaseAddressClaim,
      scheduleLeasesForRelease: vi.fn().mockResolvedValue(undefined),
      completeRequest: vi.fn().mockResolvedValue(undefined)
    };
    const resources = {
      calculateRequirements: vi.fn().mockResolvedValue([{
        resourceType: "ENERGY",
        required: 100n,
        available: 0n,
        deficit: 100n,
        balanceSun: 0n
      }]),
      prepare: vi.fn().mockRejectedValue(new PaidProviderOrderError(
        2,
        "Provider order requires manual review",
        "ENERGY_PROVIDER_OUTCOME_UNKNOWN"
      ))
    };
    const upstream = { unary: vi.fn() };
    const processor = new BroadcastProcessor(
      {
        authMode: "bound_address",
        energySource: "provider",
        insufficientPolicy: "reject",
        reclaimDelayMs: 15_000
      } as AppConfig,
      upstream as unknown as UpstreamGrpc,
      repository as unknown as GatewayRepository,
      resources as unknown as ResourceService
    );
    const sponsorAndForward = (processor as unknown as {
      sponsorAndForward(body: Buffer, inspected: InspectedTransaction): Promise<RawGrpcResponse>;
    }).sponsorAndForward.bind(processor);

    await sponsorAndForward(Buffer.alloc(0), transaction);

    expect(repository.reserveQuota).toHaveBeenCalledWith(
      transaction.ownerAddress,
      transaction.txId,
      true
    );
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(consumeQuota).toHaveBeenCalledWith(transaction.ownerAddress, transaction.txId);
    expect(releaseQuota).not.toHaveBeenCalled();
    expect(releaseAddressClaim).not.toHaveBeenCalled();
    expect(upstream.unary).not.toHaveBeenCalled();
  });

  it("never uses the insufficient-resource forward fallback for an ENERGY contract when owner ENERGY burn is disabled", async () => {
    const transaction = {
      txId: "f".repeat(64),
      ownerAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      contractType: ContractType.TriggerSmartContract,
      expirationMs: BigInt(Date.now() + 120_000),
      timestampMs: BigInt(Date.now())
    } as InspectedTransaction;
    const repository = {
      beginRequest: vi.fn().mockResolvedValue({ kind: "created" }),
      tryAcquireAddressClaim: vi.fn().mockResolvedValue(true),
      reserveQuota: vi.fn().mockResolvedValue(true),
      updateRequirements: vi.fn().mockResolvedValue(undefined),
      releaseQuota: vi.fn().mockResolvedValue(undefined),
      releaseAddressClaim: vi.fn().mockResolvedValue(undefined),
      scheduleLeasesForRelease: vi.fn().mockResolvedValue(undefined),
      completeRequest: vi.fn().mockResolvedValue(undefined)
    };
    const resources = {
      calculateRequirements: vi.fn().mockResolvedValue([{ resourceType: "ENERGY" }]),
      prepare: vi.fn().mockRejectedValue(new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "ENERGY is unavailable",
        "INSUFFICIENT_ENERGY"
      ))
    };
    const upstream = { unary: vi.fn() };
    const processor = new BroadcastProcessor(
      {
        authMode: "bound_address",
        energySource: "provider",
        insufficientPolicy: "forward",
        allowOwnerEnergyBurn: false,
        reclaimDelayMs: 15_000
      } as AppConfig,
      upstream as unknown as UpstreamGrpc,
      repository as unknown as GatewayRepository,
      resources as unknown as ResourceService
    );
    const sponsorAndForward = (processor as unknown as {
      sponsorAndForward(body: Buffer, inspected: InspectedTransaction): Promise<RawGrpcResponse>;
    }).sponsorAndForward.bind(processor);

    const response = await sponsorAndForward(Buffer.alloc(0), transaction);

    expect(decodeReturnFrame(response.body)).toMatchObject({ result: false });
    expect(upstream.unary).not.toHaveBeenCalled();
    expect(repository.releaseQuota).toHaveBeenCalledWith(transaction.ownerAddress, transaction.txId);
    expect(repository.releaseAddressClaim).toHaveBeenCalledWith(transaction.ownerAddress, transaction.txId);
  });

  it("still broadcasts with canonical headers when the post-payment state write fails", async () => {
    const transaction = {
      txId: "d".repeat(64),
      ownerAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      expirationMs: BigInt(Date.now() + 120_000),
      timestampMs: BigInt(Date.now())
    } as InspectedTransaction;
    const releaseQuota = vi.fn();
    const releaseAddressClaim = vi.fn();
    const completeRequest = vi.fn();
    const repository = {
      beginRequest: vi.fn().mockResolvedValue({ kind: "created" }),
      tryAcquireAddressClaim: vi.fn().mockResolvedValue(true),
      reserveQuota: vi.fn().mockResolvedValue(true),
      updateRequirements: vi.fn().mockResolvedValue(undefined),
      setRequestState: vi.fn().mockRejectedValue(new Error("temporary database failure")),
      recordBroadcastOutcome: vi.fn().mockResolvedValue(undefined),
      releaseQuota,
      releaseAddressClaim,
      completeRequest
    };
    const resources = {
      calculateRequirements: vi.fn().mockResolvedValue([]),
      prepare: vi.fn().mockResolvedValue({ providerOrderMayBeCharged: true })
    };
    const upstreamResponse: RawGrpcResponse = {
      headers: { ":status": 200, "content-type": "application/grpc" },
      body: encodeReturnFrame(true, ReturnCode.SUCCESS, ""),
      trailers: { "grpc-status": "0" }
    };
    const upstream = { unary: vi.fn().mockResolvedValue(upstreamResponse) };
    const processor = new BroadcastProcessor(
      {
        mode: "sponsor",
        authMode: "bound_address",
        energySource: "provider",
        insufficientPolicy: "reject",
        reclaimDelayMs: 15_000,
        minTransactionTtlMs: 5_000,
        providerOrderTimeoutMs: 5_000,
        providerConfirmTimeoutMs: 10_000,
        providerPollMs: 250
      } as AppConfig,
      upstream as unknown as UpstreamGrpc,
      repository as unknown as GatewayRepository,
      resources as unknown as ResourceService
    );
    const sponsorAndForward = (processor as unknown as {
      sponsorAndForward(body: Buffer, inspected: InspectedTransaction): Promise<RawGrpcResponse>;
    }).sponsorAndForward.bind(processor);
    const body = Buffer.from("paid-transaction-body");

    await expect(sponsorAndForward(body, transaction)).resolves.toBe(upstreamResponse);

    expect(upstream.unary).toHaveBeenCalledWith({
      ":method": "POST",
      ":path": BROADCAST_PATH,
      "content-type": "application/grpc",
      te: "trailers"
    }, body);
    expect(repository.recordBroadcastOutcome).toHaveBeenCalledTimes(1);
    expect(releaseQuota).not.toHaveBeenCalled();
    expect(releaseAddressClaim).not.toHaveBeenCalled();
    expect(completeRequest).not.toHaveBeenCalled();
  });

  it("still attempts the original broadcast when the TTL floor elapses after payment", async () => {
    const transaction = {
      txId: "e".repeat(64),
      ownerAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      expirationMs: BigInt(Date.now() + 1),
      timestampMs: BigInt(Date.now())
    } as InspectedTransaction;
    const releaseQuota = vi.fn();
    const releaseAddressClaim = vi.fn();
    const completeRequest = vi.fn();
    const repository = {
      beginRequest: vi.fn().mockResolvedValue({ kind: "created" }),
      tryAcquireAddressClaim: vi.fn().mockResolvedValue(true),
      reserveQuota: vi.fn().mockResolvedValue(true),
      updateRequirements: vi.fn().mockResolvedValue(undefined),
      setRequestState: vi.fn().mockResolvedValue(undefined),
      recordBroadcastOutcome: vi.fn().mockResolvedValue(undefined),
      releaseQuota,
      releaseAddressClaim,
      completeRequest
    };
    const resources = {
      calculateRequirements: vi.fn().mockResolvedValue([]),
      prepare: vi.fn().mockResolvedValue({ providerOrderMayBeCharged: true })
    };
    const upstreamResponse: RawGrpcResponse = {
      headers: { ":status": 200, "content-type": "application/grpc" },
      body: encodeReturnFrame(false, ReturnCode.TRANSACTION_EXPIRATION_ERROR, "expired"),
      trailers: { "grpc-status": "0" }
    };
    const upstream = { unary: vi.fn().mockResolvedValue(upstreamResponse) };
    const processor = new BroadcastProcessor(
      {
        mode: "sponsor",
        authMode: "bound_address",
        energySource: "provider",
        insufficientPolicy: "reject",
        reclaimDelayMs: 15_000,
        minTransactionTtlMs: 5_000,
        providerOrderTimeoutMs: 5_000,
        providerConfirmTimeoutMs: 10_000,
        providerPollMs: 250
      } as AppConfig,
      upstream as unknown as UpstreamGrpc,
      repository as unknown as GatewayRepository,
      resources as unknown as ResourceService
    );
    const sponsorAndForward = (processor as unknown as {
      sponsorAndForward(body: Buffer, inspected: InspectedTransaction): Promise<RawGrpcResponse>;
    }).sponsorAndForward.bind(processor);

    await expect(sponsorAndForward(Buffer.alloc(0), transaction)).resolves.toBe(upstreamResponse);

    expect(upstream.unary).toHaveBeenCalledTimes(1);
    expect(repository.recordBroadcastOutcome).toHaveBeenCalledWith(expect.objectContaining({
      accepted: false,
      errorCode: `TRON_${ReturnCode.TRANSACTION_EXPIRATION_ERROR}`,
      errorMessage: "expired"
    }));
    expect(releaseQuota).not.toHaveBeenCalled();
    expect(releaseAddressClaim).not.toHaveBeenCalled();
    expect(completeRequest).not.toHaveBeenCalled();
  });

  it("rejects a second in-flight transaction for the same address without caching the busy response", async () => {
    const transaction = {
      txId: "b".repeat(64),
      ownerAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      expirationMs: BigInt(Date.now() + 120_000)
    } as InspectedTransaction;
    const repository = {
      beginRequest: vi.fn().mockResolvedValue({ kind: "created" }),
      tryAcquireAddressClaim: vi.fn().mockResolvedValue(false),
      discardUnpreparedRequest: vi.fn().mockResolvedValue(undefined),
      reserveQuota: vi.fn()
    };
    const resources = { calculateRequirements: vi.fn(), prepare: vi.fn() };
    const upstream = { unary: vi.fn() };
    const processor = new BroadcastProcessor(
      {
        authMode: "bound_address",
        energySource: "provider",
        insufficientPolicy: "reject",
        reclaimDelayMs: 15_000
      } as AppConfig,
      upstream as unknown as UpstreamGrpc,
      repository as unknown as GatewayRepository,
      resources as unknown as ResourceService
    );
    const sponsorAndForward = (processor as unknown as {
      sponsorAndForward(body: Buffer, inspected: InspectedTransaction): Promise<RawGrpcResponse>;
    }).sponsorAndForward.bind(processor);

    const response = await sponsorAndForward(Buffer.alloc(0), transaction);

    expect(response.body.length).toBeGreaterThan(0);
    expect(repository.discardUnpreparedRequest).toHaveBeenCalledWith(transaction.txId);
    expect(repository.reserveQuota).not.toHaveBeenCalled();
    expect(resources.calculateRequirements).not.toHaveBeenCalled();
    expect(upstream.unary).not.toHaveBeenCalled();
  });

  it("preserves the address claim and quota when gRPC transport status is ambiguous", async () => {
    const transaction = {
      txId: "c".repeat(64),
      ownerAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      expirationMs: BigInt(Date.now() + 120_000)
    } as InspectedTransaction;
    const repository = {
      beginRequest: vi.fn().mockResolvedValue({ kind: "created" }),
      tryAcquireAddressClaim: vi.fn().mockResolvedValue(true),
      reserveQuota: vi.fn().mockResolvedValue(true),
      updateRequirements: vi.fn().mockResolvedValue(undefined),
      setRequestState: vi.fn().mockResolvedValue(undefined),
      recordBroadcastOutcome: vi.fn(),
      releaseQuota: vi.fn(),
      releaseAddressClaim: vi.fn()
    };
    const resources = {
      calculateRequirements: vi.fn().mockResolvedValue([]),
      prepare: vi.fn().mockResolvedValue(undefined)
    };
    const ambiguousResponse: RawGrpcResponse = {
      headers: { ":status": 200, "content-type": "application/grpc" },
      body: Buffer.alloc(0),
      trailers: { "grpc-status": "14" }
    };
    const upstream = { unary: vi.fn().mockResolvedValue(ambiguousResponse) };
    const processor = new BroadcastProcessor(
      {
        authMode: "bound_address",
        energySource: "provider",
        insufficientPolicy: "reject",
        reclaimDelayMs: 15_000,
        minTransactionTtlMs: 15_000,
        mode: "sponsor",
        providerOrderTimeoutMs: 10_000,
        providerConfirmTimeoutMs: 30_000
      } as AppConfig,
      upstream as unknown as UpstreamGrpc,
      repository as unknown as GatewayRepository,
      resources as unknown as ResourceService
    );
    const sponsorAndForward = (processor as unknown as {
      sponsorAndForward(body: Buffer, inspected: InspectedTransaction): Promise<RawGrpcResponse>;
    }).sponsorAndForward.bind(processor);

    await expect(sponsorAndForward(Buffer.alloc(0), transaction)).resolves.toBe(ambiguousResponse);
    expect(repository.recordBroadcastOutcome).not.toHaveBeenCalled();
    expect(repository.releaseQuota).not.toHaveBeenCalled();
    expect(repository.releaseAddressClaim).not.toHaveBeenCalled();
  });
});
