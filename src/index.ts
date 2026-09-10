import { AdminServer } from "./admin-server.js";
import { BroadcastProcessor } from "./broadcast-processor.js";
import { loadConfig } from "./config.js";
import { closePool, createPool, tryAcquireGatewaySingleton } from "./db.js";
import { GatewayServer } from "./grpc/gateway-server.js";
import { UpstreamGrpc } from "./grpc/upstream.js";
import { logger } from "./logger.js";
import { TronNodeApi } from "./node-api.js";
import {
  createDefaultEnergyProviderRegistry,
  EnergyProviderRepository,
  EnergyProviderService,
  ProviderSecretCipher
} from "./providers/index.js";
import { GatewayRepository } from "./repository.js";
import { ResourceService } from "./resource-service.js";
import { SignerClient } from "./signer-client.js";
import { startWorkers } from "./workers.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const instanceLock = await tryAcquireGatewaySingleton(pool);
  if (!instanceLock) {
    await closePool(pool);
    throw new Error("Another seamless gateway instance already owns the database singleton lock");
  }
  let gateway: GatewayServer | undefined;
  let admin: AdminServer | undefined;
  let upstream: UpstreamGrpc | undefined;
  try {
  const repository = new GatewayRepository(pool);
  const energyProviderRepository = config.providerMasterKey
    ? new EnergyProviderRepository(
        pool,
        ProviderSecretCipher.fromEncodedKey(config.providerMasterKey),
        {
          maxEnergyPerOrder: config.providerMaxEnergyPerOrder,
          dailyOrderLimit: config.providerDailyMaxOrders,
          dailyEnergyLimit: config.providerDailyMaxEnergy
        }
      )
    : undefined;
  const energyProviderService = energyProviderRepository
    ? new EnergyProviderService(
        energyProviderRepository,
        createDefaultEnergyProviderRegistry({
          timeoutMs: config.providerOrderTimeoutMs,
          packageThreshold: config.kuaizuPackageThreshold
        })
      )
    : undefined;
  const node = new TronNodeApi(config.nodeHttpUrl, config.nodeSolidityHttpUrl, config.nodeRequestTimeoutMs);
  const signer = new SignerClient(config.signerUrl, config.signerToken, config.nodeRequestTimeoutMs);
  upstream = new UpstreamGrpc(config.upstreamGrpcUrl, config.nodeRequestTimeoutMs);
  const resources = new ResourceService(node, signer, repository, {
    resourceOwnerAddress: config.resourceOwnerAddress ?? "",
    sponsorEnergy: config.sponsorEnergy,
    sponsorBandwidth: config.sponsorBandwidth,
    energySource: config.energySource,
    estimateSafetyBps: config.estimateSafetyBps,
    allowOwnerBandwidthBurn: config.allowOwnerBandwidthBurn,
    maxOwnerBandwidthBurnSun: config.maxOwnerBandwidthBurnSun,
    allowOwnerEnergyBurn: config.allowOwnerEnergyBurn,
    maxOwnerEnergyBurnSun: config.maxOwnerEnergyBurnSun,
    energyPackageThreshold: config.kuaizuPackageThreshold,
    minDelegateSun: config.minDelegateSun,
    delegationConfirmTimeoutMs: config.delegationConfirmTimeoutMs,
    delegationPollMs: config.delegationPollMs,
    providerConfirmTimeoutMs: config.providerConfirmTimeoutMs,
    providerOrderTimeoutMs: config.providerOrderTimeoutMs,
    providerPollMs: config.providerPollMs,
    minTransactionTtlMs: config.minTransactionTtlMs
  }, energyProviderService);
  const processor = new BroadcastProcessor(config, upstream, repository, resources);
  gateway = new GatewayServer(
    config.gatewayHost,
    config.gatewayPort,
    config.maxBroadcastBytes,
    processor,
    upstream
  );
  admin = new AdminServer(
    config.adminHost,
    config.adminPort,
    config.adminToken,
    repository,
    node,
    {
      mode: config.mode,
      gatewayPort: config.gatewayPort,
      authMode: config.authMode,
      unsupportedPolicy: config.unsupportedPolicy,
      insufficientPolicy: config.insufficientPolicy,
      sponsorEnergy: config.sponsorEnergy,
      sponsorBandwidth: config.sponsorBandwidth,
      energySource: config.energySource,
      allowOwnerBandwidthBurn: config.allowOwnerBandwidthBurn,
      maxOwnerBandwidthBurnSun: config.maxOwnerBandwidthBurnSun,
      allowOwnerEnergyBurn: config.allowOwnerEnergyBurn,
      maxOwnerEnergyBurnSun: config.maxOwnerEnergyBurnSun,
      energyPackageThreshold: config.kuaizuPackageThreshold,
      providerMaxEnergyPerOrder: config.providerMaxEnergyPerOrder,
      providerDailyMaxOrders: config.providerDailyMaxOrders,
      providerDailyMaxEnergy: config.providerDailyMaxEnergy,
      ...(config.resourceOwnerAddress ? { resourceOwnerAddress: config.resourceOwnerAddress } : {})
    },
    signer,
    energyProviderRepository,
    undefined,
    energyProviderService
  );

  await repository.ping();
  if (energyProviderService) {
    const recovered = await energyProviderService.recoverInterruptedOrders();
    if (recovered > 0) {
      logger.warn({ recovered }, "interrupted provider orders marked unknown; manual review required");
    }
  }
  await Promise.all([gateway.listen(), admin.listen()]);
  const workers = startWorkers(config, repository, node, resources);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    workers.stop();
    upstream?.close();
    await Promise.allSettled([
      gateway?.close() ?? Promise.resolve(),
      admin?.close() ?? Promise.resolve()
    ]);
    await instanceLock.release();
    await closePool(pool);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  logger.info({ mode: config.mode }, "seamless gateway started");
  } catch (error) {
    upstream?.close();
    await Promise.allSettled([
      gateway?.close() ?? Promise.resolve(),
      admin?.close() ?? Promise.resolve()
    ]);
    await instanceLock.release().catch(() => undefined);
    await closePool(pool).catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  logger.fatal({ err: error }, "gateway startup failed");
  process.exitCode = 1;
});
