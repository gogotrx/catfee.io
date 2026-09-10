import type * as http2 from "node:http2";
import type { AppConfig } from "./config.js";
import {
  BROADCAST_PATH,
  ContractType,
  GatewayError,
  ReturnCode,
  type InspectedTransaction,
  type RawGrpcResponse
} from "./domain.js";
import { decodeUnaryGrpcFrame } from "./grpc/framing.js";
import { decodeReturnFrame, encodeReturnFrame } from "./grpc/protocol.js";
import { inspectSignedTransaction } from "./grpc/transaction-inspector.js";
import { UpstreamGrpc } from "./grpc/upstream.js";
import { logger } from "./logger.js";
import { GatewayRepository } from "./repository.js";
import { PaidProviderOrderError, ResourceService } from "./resource-service.js";

export class BroadcastProcessor {
  constructor(
    private readonly config: AppConfig,
    private readonly upstream: UpstreamGrpc,
    private readonly repository: GatewayRepository,
    private readonly resources: ResourceService
  ) {}

  async handle(headers: http2.IncomingHttpHeaders, body: Buffer): Promise<RawGrpcResponse> {
    if (this.config.mode === "passthrough") return this.upstream.unary(headers, body);

    if (this.config.mode === "sponsor") {
      try {
        validateSponsoredBroadcastTransport(headers);
      } catch (error) {
        return errorResponse(error);
      }
    }

    let transaction: InspectedTransaction;
    let policyAllowed = false;
    try {
      const frame = decodeUnaryGrpcFrame(body);
      if (frame.compressed) {
        throw new GatewayError(ReturnCode.OTHER_ERROR, "Compressed broadcast requests are unsupported", "COMPRESSED_REQUEST");
      }
      transaction = inspectSignedTransaction(frame.payload);
      this.validateLifetime(transaction, "entry");
      policyAllowed = this.validatePolicy(transaction);
      await this.authorize(transaction, this.config.mode === "observe" && this.config.authEnforceInObserve);
    } catch (error) {
      if (this.config.mode === "observe" && !this.config.authEnforceInObserve) {
        logger.warn({ err: error }, "observe-mode transaction inspection failed; forwarding unchanged");
        return this.upstream.unary(headers, body);
      }
      return errorResponse(error);
    }

    if (this.config.mode === "observe") {
      try {
        const requirements = await this.resources.calculateRequirements(transaction);
        logger.info(
          {
            txId: transaction.txId,
            ownerAddress: transaction.ownerAddress,
            contractType: transaction.contractType,
            requirements: requirements.map(serializeRequirement)
          },
          "observe-mode resource estimate"
        );
      } catch (error) {
        logger.warn({ err: error, txId: transaction.txId }, "observe-mode resource estimate failed");
      }
      return this.upstream.unary(headers, body);
    }

    if (
      transaction.contractType === ContractType.TriggerSmartContract &&
      !this.config.allowOwnerEnergyBurn &&
      (!policyAllowed || !this.config.sponsorEnergy)
    ) {
      return errorResponse(new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "Smart-contract ENERGY must be prepared before broadcast",
        "ENERGY_PREPARATION_REQUIRED"
      ));
    }

    if (!policyAllowed || !isSponsorable(transaction, this.config)) {
      return this.upstream.unary(headers, body);
    }
    return this.sponsorAndForward(body, transaction);
  }

  private async sponsorAndForward(
    body: Buffer,
    transaction: InspectedTransaction
  ): Promise<RawGrpcResponse> {
    let created = false;
    let addressClaimed = false;
    let retainAddressClaim = false;
    let quotaReserved = false;
    let forwardAttempted = false;
    let providerOrderMayBeCharged = false;
    try {
      const begin = await this.repository.beginRequest(transaction);
      if (begin.kind === "cached") return cachedResponse(begin.response, begin.grpcStatus);
      if (begin.kind === "in_progress") {
        return localResponse(ReturnCode.SERVER_BUSY, `Transaction is already being processed (${begin.state})`);
      }
      created = true;

      addressClaimed = await this.repository.tryAcquireAddressClaim(
        transaction.ownerAddress,
        transaction.txId
      );
      if (!addressClaimed) {
        await this.repository.discardUnpreparedRequest(transaction.txId);
        logger.warn(
          { txId: transaction.txId, ownerAddress: transaction.ownerAddress },
          "another sponsored transaction for this address is still in progress"
        );
        return localResponse(ReturnCode.SERVER_BUSY, "Another transaction for this address is still being finalized");
      }

      if (this.config.authMode === "bound_address") {
        quotaReserved = await this.repository.reserveQuota(
          transaction.ownerAddress,
          transaction.txId,
          this.config.energySource === "provider"
        );
        if (!quotaReserved) {
          await this.repository.releaseAddressClaim(transaction.ownerAddress, transaction.txId);
          addressClaimed = false;
          return await this.rejectAndCache(transaction.txId, ReturnCode.CONTRACT_VALIDATE_ERROR, "Address quota is exhausted or unavailable", "QUOTA_UNAVAILABLE");
        }
      }

      const requirements = await this.resources.calculateRequirements(transaction);
      await this.repository.updateRequirements(transaction.txId, requirements);
      const preparation = await this.resources.prepare(transaction, requirements);
      providerOrderMayBeCharged = preparation?.providerOrderMayBeCharged === true;
      if (providerOrderMayBeCharged) {
        // ResourceService has already consumed the reserved quota. From this
        // point onward no ordinary database/lifetime error may unlock the
        // address or turn the request into a cached unpaid failure.
        quotaReserved = false;
        retainAddressClaim = true;
      }
      if (providerOrderMayBeCharged) {
        try {
          this.validateLifetime(transaction, "broadcast");
        } catch (error) {
          if (!(error instanceof GatewayError) || error.internalCode !== "TRANSACTION_TTL_TOO_SHORT") {
            throw error;
          }
          // The paid resource cannot be recovered by suppressing the original
          // broadcast. Make one immediate canonical upstream attempt and let
          // java-tron return the authoritative expiration result.
          logger.warn(
            { txId: transaction.txId },
            "transaction TTL floor elapsed after paid preparation; broadcasting immediately"
          );
        }
      } else {
        this.validateLifetime(transaction, "broadcast");
      }
      if (providerOrderMayBeCharged) {
        await bestEffort(() => this.repository.setRequestState(transaction.txId, "RESOURCE_READY"));
      } else {
        await this.repository.setRequestState(transaction.txId, "RESOURCE_READY");
      }

      forwardAttempted = true;
      const upstreamResponse = await this.upstream.unary(canonicalBroadcastHeaders(), body);
      const grpcStatus = readGrpcStatus(upstreamResponse);
      const outcome = grpcStatus === "0" ? decodeOutcome(upstreamResponse.body) : null;
      if (outcome === null) {
        logger.warn({ txId: transaction.txId }, "broadcast response could not be decoded; deferring to recovery");
        return upstreamResponse;
      }
      const accepted = outcome.result;
      await this.repository.recordBroadcastOutcome({
        txId: transaction.txId,
        ownerAddress: transaction.ownerAddress,
        accepted,
        response: upstreamResponse.body,
        grpcStatus,
        reclaimDelayMs: this.config.reclaimDelayMs,
        errorCode: accepted ? null : `TRON_${outcome.code}`,
        errorMessage: accepted ? null : outcome.message
      });
      addressClaimed = accepted;
      quotaReserved = false;
      logger.info(
        { txId: transaction.txId, ownerAddress: transaction.ownerAddress, accepted, grpcStatus },
        "original transaction forwarded"
      );
      return upstreamResponse;
    } catch (error) {
      let currentError = error;
      if (currentError instanceof PaidProviderOrderError && quotaReserved) {
        retainAddressClaim = true;
        await bestEffort(() => this.repository.consumeQuota(transaction.ownerAddress, transaction.txId));
        // Never release a quota unit after a provider request may have incurred a charge.
        // Repository recovery uses the provider-order state if this database write was ambiguous.
        quotaReserved = false;
      }
      if (providerOrderMayBeCharged) {
        retainAddressClaim = true;
        quotaReserved = false;
      }
      const gatewayError = normalizeError(currentError);
      const wouldBypassEnergyPreparation =
        transaction.contractType === ContractType.TriggerSmartContract &&
        !this.config.allowOwnerEnergyBurn;
      if (
        this.config.insufficientPolicy === "forward" &&
        gatewayError.internalCode.startsWith("INSUFFICIENT_") &&
        !wouldBypassEnergyPreparation
      ) {
        try {
          forwardAttempted = true;
          const upstreamResponse = await this.upstream.unary(canonicalBroadcastHeaders(), body);
          const grpcStatus = readGrpcStatus(upstreamResponse);
          const outcome = grpcStatus === "0" ? decodeOutcome(upstreamResponse.body) : null;
          if (outcome === null) {
            logger.warn({ txId: transaction.txId }, "fallback broadcast response is undecodable; deferring to recovery");
            return upstreamResponse;
          }
          const accepted = outcome.result;
          await this.repository.recordBroadcastOutcome({
            txId: transaction.txId,
            ownerAddress: transaction.ownerAddress,
            accepted,
            response: upstreamResponse.body,
            grpcStatus,
            reclaimDelayMs: this.config.reclaimDelayMs,
            errorCode: accepted ? null : `TRON_${outcome.code}`,
            errorMessage: accepted ? null : outcome.message
          });
          addressClaimed = accepted;
          quotaReserved = false;
          return upstreamResponse;
        } catch (fallbackError) {
          currentError = fallbackError;
        }
      }
      if (forwardAttempted) {
        logger.error(
          { err: currentError, txId: transaction.txId },
          "original broadcast outcome is uncertain; preserving quota and resources for recovery"
        );
        return localResponse(ReturnCode.SERVER_BUSY, "Broadcast outcome is being reconciled; retry later");
      }
      if (quotaReserved) {
        await bestEffort(() => this.repository.releaseQuota(transaction.ownerAddress, transaction.txId));
      }
      if (addressClaimed && !retainAddressClaim) {
        await bestEffort(() =>
          this.repository.releaseAddressClaim(transaction.ownerAddress, transaction.txId)
        );
        addressClaimed = false;
      }
      if (created && retainAddressClaim && !forwardAttempted) {
        await bestEffort(() => this.repository.setRequestState(transaction.txId, "RESOURCE_READY"));
        const finalError = normalizeError(currentError);
        logger.error(
          { err: currentError, txId: transaction.txId, internalCode: finalError.internalCode },
          "paid resource preparation cannot be cached as failed; preserving request for recovery"
        );
        return localResponse(
          ReturnCode.SERVER_BUSY,
          "Paid resource preparation is being reconciled; retry later"
        );
      }
      if (created) {
        await bestEffort(() => this.repository.scheduleLeasesForRelease(transaction.txId, this.config.reclaimDelayMs));
        const finalError = normalizeError(currentError);
        const response = localResponse(finalError.returnCode, finalError.publicMessage);
        await bestEffort(() =>
          this.repository.completeRequest(
            transaction.txId,
            "FAILED",
            response.body,
            "0",
            finalError.internalCode,
            finalError.publicMessage
          )
        );
        logger.error(
          { err: currentError, txId: transaction.txId, internalCode: finalError.internalCode },
          "sponsored broadcast failed"
        );
        return response;
      }
      return errorResponse(currentError);
    }
  }

  private validateLifetime(transaction: InspectedTransaction, phase: "entry" | "broadcast"): void {
    const now = BigInt(Date.now());
    if (phase === "entry") {
      if (transaction.expirationMs - now > BigInt(this.config.maxTransactionTtlMs)) {
        throw new GatewayError(
          ReturnCode.TRANSACTION_EXPIRATION_ERROR,
          "Transaction expiration is too far in the future",
          "TRANSACTION_TTL_TOO_LONG"
        );
      }
      if (
        transaction.timestampMs > now + BigInt(this.config.maxTransactionFutureSkewMs) ||
        transaction.timestampMs < now - BigInt(this.config.maxTransactionAgeMs)
      ) {
        throw new GatewayError(
          ReturnCode.TRANSACTION_EXPIRATION_ERROR,
          "Transaction timestamp is outside the accepted freshness window",
          "TRANSACTION_TIMESTAMP_INVALID"
        );
      }
    }
    const providerPreparationBudget =
      phase === "entry" && this.config.mode === "sponsor" && this.config.energySource === "provider"
        ? this.config.providerOrderTimeoutMs +
          this.config.providerConfirmTimeoutMs +
          this.config.providerPollMs +
          this.config.minTransactionTtlMs
        : 0;
    const requiredTtlMs = Math.max(this.config.minTransactionTtlMs, providerPreparationBudget);
    if (transaction.expirationMs - now < BigInt(requiredTtlMs)) {
      throw new GatewayError(
        ReturnCode.TRANSACTION_EXPIRATION_ERROR,
        "Transaction is expired or too close to expiration",
        "TRANSACTION_TTL_TOO_SHORT"
      );
    }
  }

  private validatePolicy(transaction: InspectedTransaction): boolean {
    if (this.config.energySource === "provider" && transaction.memoLength > 0) {
      return this.unsupported("Paid external-energy transactions cannot include a memo");
    }
    if (transaction.contractType === ContractType.TriggerSmartContract) {
      if (
        (transaction.callValue ?? 0n) !== 0n ||
        (transaction.callTokenValue ?? 0n) !== 0n ||
        (transaction.tokenId ?? 0n) !== 0n
      ) {
        return this.unsupported("Sponsored TRC20 calls cannot attach native TRX or TRC10 value");
      }
      if (
        !transaction.contractAddress ||
        !transaction.functionSelector ||
        !this.config.allowedContracts.has(transaction.contractAddress) ||
        !this.config.allowedSelectors.has(transaction.functionSelector.toLowerCase())
      ) {
        return this.unsupported("Contract address or function selector is not permitted");
      }
      if (
        (transaction.functionSelector === "a9059cbb" || transaction.functionSelector === "095ea7b3") &&
        transaction.triggerData?.length !== 136
      ) {
        return this.unsupported("TRC20 transfer and approve calldata must use the canonical 68-byte ABI form");
      }
      return true;
    }
    if (transaction.contractType !== ContractType.TransferContract) {
      return this.unsupported(`Contract type ${transaction.contractType} is not supported`);
    }
    return true;
  }

  private unsupported(message: string): false {
    if (this.config.unsupportedPolicy === "reject") {
      throw new GatewayError(ReturnCode.CONTRACT_VALIDATE_ERROR, message, "UNSUPPORTED_TRANSACTION");
    }
    return false;
  }

  private async authorize(transaction: InspectedTransaction, enforceInObserve: boolean): Promise<void> {
    if (this.config.authMode !== "bound_address") return;
    const binding = await this.repository.getBinding(transaction.ownerAddress);
    const usable = binding?.enabled && (!binding.expiresAt || binding.expiresAt.getTime() > Date.now());
    if (!usable && (this.config.mode === "sponsor" || enforceInObserve)) {
      throw new GatewayError(ReturnCode.CONTRACT_VALIDATE_ERROR, "Owner address is not enabled", "ADDRESS_NOT_BOUND");
    }
  }

  private async rejectAndCache(
    txId: string,
    code: number,
    message: string,
    internalCode: string
  ): Promise<RawGrpcResponse> {
    const response = localResponse(code, message);
    await this.repository.completeRequest(txId, "REJECTED", response.body, "0", internalCode, message);
    logger.warn({ txId, internalCode }, "sponsored broadcast rejected");
    return response;
  }
}

function isSponsorable(transaction: InspectedTransaction, config: AppConfig): boolean {
  if (transaction.contractType === ContractType.TriggerSmartContract) {
    return config.sponsorEnergy || config.sponsorBandwidth;
  }
  return transaction.contractType === ContractType.TransferContract && config.sponsorBandwidth;
}

function validateSponsoredBroadcastTransport(headers: http2.IncomingHttpHeaders): void {
  const contentType = headers["content-type"];
  if (
    headers[":method"] !== "POST" ||
    typeof contentType !== "string" ||
    !/^application\/grpc(?:\+proto)?$/i.test(contentType.trim())
  ) {
    throw new GatewayError(
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "Sponsored broadcasts require POST with application/grpc content type",
      "INVALID_BROADCAST_TRANSPORT"
    );
  }
}

function canonicalBroadcastHeaders(): http2.IncomingHttpHeaders {
  return {
    ":method": "POST",
    ":path": BROADCAST_PATH,
    "content-type": "application/grpc",
    te: "trailers"
  };
}

function decodeOutcome(body: Buffer): { result: boolean; code: number; message: string } | null {
  try {
    return decodeReturnFrame(body);
  } catch {
    return null;
  }
}

function readGrpcStatus(response: RawGrpcResponse): string {
  const value = response.trailers["grpc-status"] ?? response.headers["grpc-status"] ?? "0";
  return Array.isArray(value) ? String(value[0] ?? "0") : String(value);
}

function cachedResponse(body: Buffer, grpcStatus: string): RawGrpcResponse {
  return {
    headers: { ":status": 200, "content-type": "application/grpc" },
    body,
    trailers: { "grpc-status": grpcStatus }
  };
}

function localResponse(code: number, message: string): RawGrpcResponse {
  return cachedResponse(encodeReturnFrame(false, code, message), "0");
}

function errorResponse(error: unknown): RawGrpcResponse {
  const normalized = normalizeError(error);
  logger.warn({ err: error, internalCode: normalized.internalCode }, "broadcast request rejected");
  return localResponse(normalized.returnCode, normalized.publicMessage);
}

function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError(ReturnCode.SERVER_BUSY, "Seamless resource service is temporarily unavailable", "INTERNAL_ERROR", {
    cause: error
  });
}

function serializeRequirement(requirement: {
  resourceType: string;
  estimated: bigint;
  required: bigint;
  available: bigint;
  deficit: bigint;
  balanceSun: bigint;
}): Record<string, string> {
  return {
    resourceType: requirement.resourceType,
    estimated: requirement.estimated.toString(),
    required: requirement.required.toString(),
    available: requirement.available.toString(),
    deficit: requirement.deficit.toString(),
    balanceSun: requirement.balanceSun.toString()
  };
}

async function bestEffort(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.error({ err: error }, "best-effort cleanup failed");
  }
}
