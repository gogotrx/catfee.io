import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { TronNodeApi } from "./node-api.js";
import { GatewayRepository } from "./repository.js";
import { ResourceService } from "./resource-service.js";
import { ReturnCode } from "./domain.js";
import { encodeReturnFrame } from "./grpc/protocol.js";

const FINALITY_GRACE_MS = 10 * 60 * 1_000;
const RELEASE_REBROADCAST_AFTER_MS = 3 * 60 * 1_000;

export type WorkerController = { stop(): void };

export function startWorkers(
  config: AppConfig,
  repository: GatewayRepository,
  node: TronNodeApi,
  resources: ResourceService
): WorkerController {
  if (config.mode !== "sponsor") return { stop() {} };

  let stopped = false;
  let confirmationTimer: NodeJS.Timeout | undefined;
  let reclaimTimer: NodeJS.Timeout | undefined;

  const confirmationLoop = async () => {
    try {
      const releasedClaims = await repository.releaseTerminalAddressClaims();
      if (releasedClaims > 0) {
        logger.warn({ releasedClaims }, "released stale terminal address sponsorship claims");
      }
      const staleRequests = await repository.listStaleRequests();
      for (const request of staleRequests) {
        const receipt = await node.getFullNodeReceipt(request.txId);
        if (receipt) {
          await repository.recordBroadcastOutcome({
            txId: request.txId,
            ownerAddress: request.ownerAddress,
            accepted: true,
            response: encodeReturnFrame(true, ReturnCode.SUCCESS, ""),
            grpcStatus: "0",
            reclaimDelayMs: config.reclaimDelayMs
          });
          logger.warn({ txId: request.txId }, "recovered accepted transaction after an interrupted broadcast");
        } else if (Date.now() > Number(request.expirationMs) + 120_000) {
          await repository.recordBroadcastOutcome({
            txId: request.txId,
            ownerAddress: request.ownerAddress,
            accepted: false,
            response: encodeReturnFrame(
              false,
              ReturnCode.TRANSACTION_EXPIRATION_ERROR,
              "Transaction recovery window expired"
            ),
            grpcStatus: "0",
            reclaimDelayMs: config.reclaimDelayMs
          });
          logger.warn({ txId: request.txId }, "expired interrupted broadcast and scheduled resource release");
        }
      }
      const requests = await repository.listRequestsAwaitingFinality();
      for (const request of requests) {
        const receipt = await node.getSolidifiedReceipt(request.txId);
        if (receipt) {
          const success = successfulReceipt(receipt);
          await repository.markFinalized(request.txId, success, config.reclaimDelayMs, receipt);
          logger.info({ txId: request.txId, success }, "original transaction solidified");
        } else if (Date.now() > Number(request.expirationMs) + FINALITY_GRACE_MS) {
          await repository.expireRequest(request.txId, config.reclaimDelayMs);
          logger.warn({ txId: request.txId }, "transaction finality deadline expired; resources scheduled for release");
        }
      }
    } catch (error) {
      logger.error({ err: error }, "confirmation worker iteration failed");
    } finally {
      if (!stopped) confirmationTimer = setTimeout(confirmationLoop, config.confirmationIntervalMs);
    }
  };

  const reclaimLoop = async () => {
    try {
      const broadcasts = await repository.listReleaseBroadcasts();
      for (const lease of broadcasts) {
        if (!lease.undelegateTxId) continue;
        const receipt = await node.getFullNodeReceipt(lease.undelegateTxId);
        if (receipt && successfulReceipt(receipt)) {
          await repository.markLeaseReleased(lease.id, lease.undelegateTxId);
          logger.info({ leaseId: lease.id.toString(), txId: lease.undelegateTxId }, "undelegation reconciled");
        } else if (receipt || Date.now() - lease.updatedAt.getTime() > RELEASE_REBROADCAST_AFTER_MS) {
          await repository.retryLeaseRelease(
            lease.id,
            receipt ? "Undelegation transaction failed" : "Undelegation transaction was not observed before expiry"
          );
        }
      }
      const leases = await repository.listLeasesReadyToRelease();
      for (const lease of leases) {
        if (!(await repository.claimLeaseForRelease(lease.id))) continue;
        try {
          await resources.releaseLease(lease);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, leaseId: lease.id.toString() }, "resource lease release failed");
          await repository.retryLeaseRelease(lease.id, message);
        }
      }
    } catch (error) {
      logger.error({ err: error }, "resource reclaim worker iteration failed");
    } finally {
      if (!stopped) reclaimTimer = setTimeout(reclaimLoop, config.reclaimIntervalMs);
    }
  };

  void confirmationLoop();
  void reclaimLoop();
  return {
    stop() {
      stopped = true;
      if (confirmationTimer) clearTimeout(confirmationTimer);
      if (reclaimTimer) clearTimeout(reclaimTimer);
    }
  };
}

function successfulReceipt(receipt: Record<string, unknown>): boolean {
  const receiptBody = receipt.receipt as Record<string, unknown> | undefined;
  const value = String(receipt.result ?? receiptBody?.result ?? "SUCCESS").toUpperCase();
  return value === "SUCCESS";
}
