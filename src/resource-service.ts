import { AsyncMutex } from "./async-mutex.js";
import { GatewayError, ReturnCode, type InspectedTransaction, type LeaseRecord, type ResourceRequirement, type ResourceType } from "./domain.js";
import { logger } from "./logger.js";
import { TronNodeApi } from "./node-api.js";
import type { EnergyProviderService } from "./providers/service.js";
import { PotentiallyChargedProviderError } from "./providers/types.js";
import { GatewayRepository } from "./repository.js";
import {
  accountBalanceSun,
  applySafetyBasisPoints,
  availableResource,
  estimateSignedTransactionBandwidth,
  planOwnerBandwidthPayment,
  resourceUnitsToStakeSun,
  type OwnerBandwidthPaymentPlan
} from "./resource-math.js";
import { SignerClient } from "./signer-client.js";
import { normalizeTronAddress } from "./tron-address.js";

type ResourceServiceOptions = {
  resourceOwnerAddress: string;
  sponsorEnergy: boolean;
  sponsorBandwidth: boolean;
  energySource: "self" | "provider";
  estimateSafetyBps: number;
  allowOwnerBandwidthBurn: boolean;
  maxOwnerBandwidthBurnSun: bigint;
  allowOwnerEnergyBurn: boolean;
  maxOwnerEnergyBurnSun: bigint;
  energyPackageThreshold: number;
  minDelegateSun: bigint;
  delegationConfirmTimeoutMs: number;
  delegationPollMs: number;
  providerConfirmTimeoutMs: number;
  providerOrderTimeoutMs: number;
  providerPollMs: number;
  minTransactionTtlMs: number;
};

export type ResourcePreparationResult = {
  providerOrderMayBeCharged: boolean;
};

export class ResourceService {
  private readonly mutationMutex = new AsyncMutex();

  constructor(
    private readonly node: TronNodeApi,
    private readonly signer: SignerClient,
    private readonly repository: GatewayRepository,
    private readonly options: ResourceServiceOptions,
    private readonly energyProviders?: Pick<
      EnergyProviderService,
      "quoteMinimumEnergyAmount" | "orderEnergy" | "markFulfilled" | "markConfirmationTimeout"
    >
  ) {}

  async calculateRequirements(transaction: InspectedTransaction): Promise<ResourceRequirement[]> {
    const accountResource = await this.node.getAccountResource(transaction.ownerAddress);
    const requirements: ResourceRequirement[] = [];

    if (this.options.sponsorEnergy && transaction.contractAddress && transaction.triggerData) {
      const estimated = await this.node.estimateEnergy({
        ownerAddress: transaction.ownerAddress,
        contractAddress: transaction.contractAddress,
        data: transaction.triggerData,
        callValue: transaction.callValue ?? 0n,
        callTokenValue: transaction.callTokenValue ?? 0n,
        tokenId: transaction.tokenId ?? 0n
      });
      requirements.push(
        this.makeRequirement(
          "ENERGY",
          estimated,
          applySafetyBasisPoints(estimated, this.options.estimateSafetyBps),
          accountResource
        )
      );
    }

    if (this.options.sponsorBandwidth) {
      const estimated = estimateSignedTransactionBandwidth(transaction.transactionBytes);
      requirements.push(this.makeRequirement("BANDWIDTH", estimated, estimated, accountResource));
    }
    return requirements;
  }

  async prepare(
    transaction: InspectedTransaction,
    requirements: readonly ResourceRequirement[]
  ): Promise<ResourcePreparationResult> {
    return this.mutationMutex.runExclusive(async () => {
      let providerOrderMayBeCharged = false;
      for (const requirement of requirements) {
        if (requirement.resourceType === "ENERGY" && this.options.energySource === "provider") {
          providerOrderMayBeCharged =
            await this.rentExternalEnergy(transaction, requirement) || providerOrderMayBeCharged;
          continue;
        }
        if (requirement.deficit <= 0n) continue;
        if (requirement.balanceSun <= 0n) continue;
        await this.delegate(transaction, requirement);
      }
      if (!this.options.allowOwnerEnergyBurn) {
        await this.assertEnergyReadyForBroadcast(
          transaction.ownerAddress,
          requirements,
          providerOrderMayBeCharged
        );
      }
      return { providerOrderMayBeCharged };
    });
  }

  async releaseLease(lease: LeaseRecord): Promise<void> {
    await this.mutationMutex.runExclusive(async () => {
      if (lease.delegateTxId) {
        const delegateReceipt = await this.node.getFullNodeReceipt(lease.delegateTxId);
        if (!delegateReceipt) {
          if (Date.now() - lease.createdAt.getTime() > 10 * 60 * 1_000) {
            await this.repository.markLeaseWithoutDelegation(lease.id, "Delegation transaction was never observed");
            return;
          }
          throw new Error("Delegation transaction is not yet visible");
        }
        if (!isSuccessfulReceipt(delegateReceipt)) {
          await this.repository.markLeaseWithoutDelegation(lease.id, "Delegation transaction failed");
          return;
        }
      }
      const unsigned = await this.node.buildUndelegation({
        ownerAddress: lease.resourceOwnerAddress,
        receiverAddress: lease.receiverAddress,
        resourceType: lease.resourceType,
        balanceSun: lease.balanceSun
      });
      const signed = await this.signer.sign(unsigned);
      const txId = transactionId(signed);
      await this.repository.markLeaseUndelegateBroadcast(lease.id, txId);
      try {
        await this.node.broadcastTransaction(signed);
      } catch (error) {
        // A transport failure is ambiguous: the node may still have accepted
        // the tx. Keep its txID and let reconciliation decide before retrying.
        logger.warn({ err: error, leaseId: lease.id.toString(), txId }, "undelegation broadcast outcome is uncertain");
        return;
      }
      try {
        const receipt = await this.node.waitForFullNodeReceipt(
          txId,
          this.options.delegationConfirmTimeoutMs,
          this.options.delegationPollMs
        );
        assertSuccessfulReceipt(receipt, "Resource undelegation failed");
        await this.repository.markLeaseReleased(lease.id, txId);
        logger.info({ leaseId: lease.id.toString(), txId, resourceType: lease.resourceType }, "resource lease released");
      } catch (error) {
        // Leave RELEASE_BROADCAST for the reconciliation worker. It must not
        // create a duplicate undelegation while the first transaction may land.
        logger.warn({ err: error, leaseId: lease.id.toString(), txId }, "undelegation confirmation is pending");
      }
    });
  }

  private makeRequirement(
    resourceType: ResourceType,
    estimated: bigint,
    required: bigint,
    accountResource: Record<string, unknown>
  ): ResourceRequirement {
    const available = availableResource(accountResource, resourceType);
    const deficit = required > available ? required - available : 0n;
    const balanceSun =
      resourceType === "ENERGY" && this.options.energySource === "provider"
        ? 0n
        : resourceUnitsToStakeSun(
            deficit,
            accountResource,
            resourceType,
            this.options.minDelegateSun
          );
    return { resourceType, estimated, required, available, deficit, balanceSun };
  }

  private async rentExternalEnergy(
    transaction: InspectedTransaction,
    requirement: ResourceRequirement
  ): Promise<boolean> {
    if (!this.energyProviders) {
      throw new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "No external energy provider is configured",
        "ENERGY_PROVIDER_UNAVAILABLE"
      );
    }

    const [account, latestResources, prices, taposMatches] = await Promise.all([
      this.node.getAccount(transaction.ownerAddress),
      this.node.getAccountResource(transaction.ownerAddress),
      this.node.getResourcePrices(),
      this.node.matchesTapos(transaction.refBlockBytes, transaction.refBlockHash)
    ]);
    if (!taposMatches) {
      throw new GatewayError(
        ReturnCode.TAPOS_ERROR,
        "Transaction TAPOS reference does not match the current chain",
        "TAPOS_REFERENCE_MISMATCH"
      );
    }
    assertExternalEnergyReceiver(account, transaction.ownerAddress);
    assertSingleOwnerPermission(account, transaction.ownerAddress);
    const ownerBalance = accountBalanceSun(account);
    const bandwidthPlan = planOwnerBandwidthPayment(
      estimateSignedTransactionBandwidth(transaction.transactionBytes),
      latestResources,
      prices.bandwidthFeeSun
    );

    const latestAvailable = availableResource(latestResources, "ENERGY");
    const minimumFeeLimitSun = requirement.required * prices.energyFeeSun;
    if (latestAvailable >= requirement.required) {
      await this.repository.upsertResourceAuditPlan(transaction.txId, {
        energyEstimateRaw: requirement.estimated,
        energyEstimateSafe: requirement.required,
        estimateSafetyBps: this.options.estimateSafetyBps,
        energyAvailableBefore: latestAvailable,
        packageThreshold: BigInt(this.options.energyPackageThreshold),
        energyPackageQuoted: null,
        energyPriceSun: prices.energyFeeSun,
        estimatedEnergyBurnSun: 0n,
        bandwidthBytes: bandwidthPlan.requiredBytes,
        bandwidthStakedAvailable: bandwidthPlan.stakedAvailable,
        bandwidthFreeAvailable: bandwidthPlan.freeAvailable,
        bandwidthSource: bandwidthPlan.source,
        bandwidthUnitPriceSun: bandwidthPlan.unitPriceSun,
        estimatedBandwidthBurnSun: bandwidthPlan.burnSun,
        ownerBalanceSun: ownerBalance,
        feeLimitSun: transaction.feeLimitSun,
        minimumFeeLimitSun,
        maximumFeeLimitSun: prices.maxFeeLimitSun
      });
      this.assertFeeLimitSufficient(transaction, minimumFeeLimitSun, prices.maxFeeLimitSun);
      this.assertOwnerBandwidthPaymentAllowed(bandwidthPlan);
      if (ownerBalance < bandwidthPlan.burnSun) {
        throw new GatewayError(
          ReturnCode.BANDWITH_ERROR,
          "The owner account cannot cover the estimated TRX bandwidth charge",
          "INSUFFICIENT_OWNER_TRX_FOR_BANDWIDTH"
        );
      }
      return false;
    }
    const numericAmount = safeEnergyNumber(requirement.estimated);
    const strictMinimumPackage = this.options.allowOwnerEnergyBurn
      ? undefined
      : safeEnergyNumber(requirement.required - latestAvailable);
    const quotedPackage = await this.energyProviders.quoteMinimumEnergyAmount(
      numericAmount,
      strictMinimumPackage
    );
    if (quotedPackage === null) {
      const unprovidedEnergy = requirement.required > latestAvailable
        ? requirement.required - latestAvailable
        : 0n;
      await this.repository.upsertResourceAuditPlan(transaction.txId, {
        energyEstimateRaw: requirement.estimated,
        energyEstimateSafe: requirement.required,
        estimateSafetyBps: this.options.estimateSafetyBps,
        energyAvailableBefore: latestAvailable,
        packageThreshold: BigInt(this.options.energyPackageThreshold),
        energyPackageQuoted: null,
        energyPriceSun: prices.energyFeeSun,
        estimatedEnergyBurnSun: unprovidedEnergy * prices.energyFeeSun,
        bandwidthBytes: bandwidthPlan.requiredBytes,
        bandwidthStakedAvailable: bandwidthPlan.stakedAvailable,
        bandwidthFreeAvailable: bandwidthPlan.freeAvailable,
        bandwidthSource: bandwidthPlan.source,
        bandwidthUnitPriceSun: bandwidthPlan.unitPriceSun,
        estimatedBandwidthBurnSun: bandwidthPlan.burnSun,
        ownerBalanceSun: ownerBalance,
        feeLimitSun: transaction.feeLimitSun,
        minimumFeeLimitSun,
        maximumFeeLimitSun: prices.maxFeeLimitSun
      });
      this.assertFeeLimitSufficient(transaction, minimumFeeLimitSun, prices.maxFeeLimitSun);
      throw new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "No enabled energy provider can supply a compatible package",
        "ENERGY_PROVIDER_PACKAGE_UNAVAILABLE"
      );
    }
    const projectedEnergy = latestAvailable + BigInt(quotedPackage);
    const projectedEnergyDeficit = requirement.required > projectedEnergy
      ? requirement.required - projectedEnergy
      : 0n;
    const estimatedEnergyBurnSun = projectedEnergyDeficit * prices.energyFeeSun;
    const totalEstimatedBurnSun = bandwidthPlan.burnSun + estimatedEnergyBurnSun;

    await this.repository.upsertResourceAuditPlan(transaction.txId, {
      energyEstimateRaw: requirement.estimated,
      energyEstimateSafe: requirement.required,
      estimateSafetyBps: this.options.estimateSafetyBps,
      energyAvailableBefore: latestAvailable,
      packageThreshold: BigInt(this.options.energyPackageThreshold),
      energyPackageQuoted: BigInt(quotedPackage),
      energyPriceSun: prices.energyFeeSun,
      estimatedEnergyBurnSun,
      bandwidthBytes: bandwidthPlan.requiredBytes,
      bandwidthStakedAvailable: bandwidthPlan.stakedAvailable,
      bandwidthFreeAvailable: bandwidthPlan.freeAvailable,
      bandwidthSource: bandwidthPlan.source,
      bandwidthUnitPriceSun: bandwidthPlan.unitPriceSun,
      estimatedBandwidthBurnSun: bandwidthPlan.burnSun,
      ownerBalanceSun: ownerBalance,
      feeLimitSun: transaction.feeLimitSun,
      minimumFeeLimitSun,
      maximumFeeLimitSun: prices.maxFeeLimitSun
    });

    this.assertFeeLimitSufficient(transaction, minimumFeeLimitSun, prices.maxFeeLimitSun);
    this.assertOwnerBandwidthPaymentAllowed(bandwidthPlan);
    this.assertOwnerEnergyPaymentAllowed(estimatedEnergyBurnSun);
    if (ownerBalance < totalEstimatedBurnSun) {
      throw new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "The owner account cannot cover the estimated TRX resource charge",
        "INSUFFICIENT_OWNER_TRX_FOR_RESOURCES"
      );
    }

    const remainingTtlMs = transaction.expirationMs - BigInt(Date.now());
    const minimumBeforeOrder = BigInt(
      this.options.providerOrderTimeoutMs +
      this.options.providerConfirmTimeoutMs +
      this.options.providerPollMs +
      this.options.minTransactionTtlMs
    );
    if (remainingTtlMs < minimumBeforeOrder) {
      throw new GatewayError(
        ReturnCode.TRANSACTION_EXPIRATION_ERROR,
        "Transaction is too close to expiration to place a paid energy order",
        "TRANSACTION_TTL_TOO_SHORT_FOR_PROVIDER"
      );
    }
    const providerRequestDeadlineMs = transaction.expirationMs - minimumBeforeOrder;
    if (providerRequestDeadlineMs > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GatewayError(
        ReturnCode.TRANSACTION_EXPIRATION_ERROR,
        "Transaction expiration is outside the supported range",
        "TRANSACTION_EXPIRATION_UNSAFE"
      );
    }
    if (!await this.node.matchesTapos(transaction.refBlockBytes, transaction.refBlockHash)) {
      throw new GatewayError(
        ReturnCode.TAPOS_ERROR,
        "Transaction TAPOS reference expired during paid-resource preparation",
        "TAPOS_REFERENCE_EXPIRED_BEFORE_ORDER"
      );
    }
    if (await this.node.hasTransaction(transaction.txId)) {
      throw new GatewayError(
        ReturnCode.DUP_TRANSACTION_ERROR,
        "Transaction is already pending or recorded by the FullNode",
        "TRANSACTION_ALREADY_VISIBLE_BEFORE_ORDER"
      );
    }

    let result;
    try {
      result = await this.energyProviders.orderEnergy({
        txId: transaction.txId,
        receiveAddress: transaction.ownerAddress,
        amount: numericAmount,
        minimumPackageAmount: quotedPackage,
        providerRequestDeadlineMs: Number(providerRequestDeadlineMs)
      });
    } catch (error) {
      if (error instanceof PotentiallyChargedProviderError) {
        await this.consumePotentiallyChargedQuota(transaction, error);
        throw new PaidProviderOrderError(
          ReturnCode.CONTRACT_VALIDATE_ERROR,
          "Energy provider order outcome is pending manual review",
          error.internalCode,
          { cause: error }
        );
      }
      throw error;
    }

    const duplicateState = result.kind === "duplicate" ? result.order.state : null;
    const potentiallyCharged =
      result.kind === "accepted" ||
      result.kind === "unknown" ||
      (result.kind === "duplicate" &&
        (duplicateState === "ORDERING" ||
          duplicateState === "ACCEPTED" ||
          duplicateState === "FULFILLED" ||
          duplicateState === "UNKNOWN"));
    if (potentiallyCharged) {
      await this.consumePotentiallyChargedQuota(transaction);
    }
    if (result.order.providerId !== null) {
      await bestEffortResourceAudit(
        () => this.repository.recordEnergyPackageAttempt(
          transaction.txId,
          BigInt(result.order.amount)
        ),
        transaction.txId,
        "energy package attempt"
      );
    }

    const ordered =
      result.kind === "accepted" ||
      (result.kind === "duplicate" &&
        (duplicateState === "ACCEPTED" || duplicateState === "FULFILLED"));
    if (!ordered) {
      const internalCode = result.kind === "unknown"
        ? "ENERGY_PROVIDER_OUTCOME_UNKNOWN"
        : result.kind === "duplicate"
          ? `ENERGY_PROVIDER_DUPLICATE_${result.order.state}`
          : "ENERGY_PROVIDER_REJECTED";
      throw potentiallyCharged
        ? new PaidProviderOrderError(
            ReturnCode.CONTRACT_VALIDATE_ERROR,
            result.kind === "unknown"
              ? "Energy order outcome is pending manual review"
              : "Energy provider order requires manual review",
            internalCode
          )
        : new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "External energy provider could not fulfill the order",
        internalCode
      );
    }

    const deadline = Date.now() + this.options.providerConfirmTimeoutMs;
    const confirmationTarget = this.options.allowOwnerEnergyBurn
      ? minimumBigInt(requirement.required, latestAvailable + BigInt(result.order.amount))
      : requirement.required;
    let highestRecordedAvailable: bigint | null = null;
    let lastConfirmationError: unknown;
    while (Date.now() < deadline) {
      try {
        const resources = await this.node.getAccountResource(transaction.ownerAddress);
        const availableAfter = availableResource(resources, "ENERGY");
        if (highestRecordedAvailable === null || availableAfter > highestRecordedAvailable) {
          await bestEffortResourceAudit(
            () => this.repository.recordEnergyArrival(transaction.txId, availableAfter),
            transaction.txId,
            "energy arrival"
          );
          highestRecordedAvailable = availableAfter;
        }
        if (availableAfter >= confirmationTarget) {
          await bestEffortProviderState(() => this.energyProviders!.markFulfilled(transaction.txId));
          logger.info(
            {
              txId: transaction.txId,
              providerOrderId: result.order.providerOrderId,
              estimatedEnergyAmount: numericAmount,
              safeEnergyAmount: requirement.required.toString(),
              orderedEnergyAmount: result.order.amount,
              availableEnergyAfterOrder: availableAfter.toString(),
              estimatedOwnerEnergyBurnSun: estimatedEnergyBurnSun.toString(),
              bandwidthPaymentSource: bandwidthPlan.source,
              estimatedOwnerBandwidthBurnSun: bandwidthPlan.burnSun.toString()
            },
            "external energy order confirmed"
          );
          return true;
        }
        lastConfirmationError = undefined;
      } catch (error) {
        lastConfirmationError = error;
        logger.warn(
          { err: error, txId: transaction.txId },
          "energy delivery confirmation poll failed; retrying until the deadline"
        );
      }
      await delay(this.options.providerPollMs);
    }
    await bestEffortProviderState(() => this.energyProviders!.markConfirmationTimeout(transaction.txId));
    throw new PaidProviderOrderError(
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "Energy order was placed but has not reached the account yet",
      lastConfirmationError
        ? "ENERGY_PROVIDER_CONFIRMATION_UNAVAILABLE"
        : "ENERGY_PROVIDER_CONFIRM_TIMEOUT",
      lastConfirmationError ? { cause: lastConfirmationError } : undefined
    );
  }

  private async consumePotentiallyChargedQuota(
    transaction: InspectedTransaction,
    cause?: unknown
  ): Promise<void> {
    try {
      await this.repository.consumeQuota(transaction.ownerAddress, transaction.txId);
    } catch (error) {
      throw new PaidProviderOrderError(
        ReturnCode.SERVER_BUSY,
        "Energy order accounting is being reconciled; retry later",
        "ENERGY_PROVIDER_QUOTA_RECONCILIATION_REQUIRED",
        { cause: cause ?? error }
      );
    }
  }

  private assertOwnerBandwidthPaymentAllowed(plan: OwnerBandwidthPaymentPlan): void {
    if (plan.burnSun <= 0n) return;
    if (!this.options.allowOwnerBandwidthBurn) {
      throw new GatewayError(
        ReturnCode.BANDWITH_ERROR,
        "The transaction may require an owner TRX bandwidth fallback, which is disabled",
        "OWNER_BANDWIDTH_BURN_DISABLED"
      );
    }
    if (plan.burnSun > this.options.maxOwnerBandwidthBurnSun) {
      throw new GatewayError(
        ReturnCode.BANDWITH_ERROR,
        "The estimated owner bandwidth charge exceeds the configured limit",
        "OWNER_BANDWIDTH_BURN_LIMIT_EXCEEDED"
      );
    }
  }

  private async assertEnergyReadyForBroadcast(
    ownerAddress: string,
    requirements: readonly ResourceRequirement[],
    providerOrderMayBeCharged: boolean
  ): Promise<void> {
    const energy = requirements.find((requirement) => requirement.resourceType === "ENERGY");
    if (!energy) return;
    let resources: Record<string, unknown>;
    try {
      resources = await this.node.getAccountResource(ownerAddress);
    } catch (error) {
      if (providerOrderMayBeCharged) {
        throw new PaidProviderOrderError(
          ReturnCode.SERVER_BUSY,
          "Paid ENERGY could not be rechecked; the transaction was not broadcast",
          "ENERGY_RECHECK_UNAVAILABLE_AFTER_PROVIDER",
          { cause: error }
        );
      }
      throw new GatewayError(
        ReturnCode.SERVER_BUSY,
        "ENERGY availability could not be verified; the transaction was not broadcast",
        "ENERGY_RECHECK_UNAVAILABLE",
        { cause: error }
      );
    }
    const available = availableResource(resources, "ENERGY");
    if (available >= energy.required) return;
    if (providerOrderMayBeCharged) {
      throw new PaidProviderOrderError(
        ReturnCode.SERVER_BUSY,
        "Paid ENERGY is not fully available; the transaction was not broadcast",
        "ENERGY_NOT_READY_AFTER_PROVIDER"
      );
    }
    throw new GatewayError(
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "ENERGY is not fully available; the transaction was not broadcast",
      "ENERGY_NOT_READY_FOR_BROADCAST"
    );
  }

  private assertOwnerEnergyPaymentAllowed(estimatedBurnSun: bigint): void {
    if (estimatedBurnSun <= 0n) return;
    if (!this.options.allowOwnerEnergyBurn) {
      throw new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "The selected package leaves an ENERGY remainder and owner TRX fallback is disabled",
        "OWNER_ENERGY_BURN_DISABLED"
      );
    }
    if (estimatedBurnSun > this.options.maxOwnerEnergyBurnSun) {
      throw new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "The estimated owner ENERGY charge exceeds the configured limit",
        "OWNER_ENERGY_BURN_LIMIT_EXCEEDED"
      );
    }
  }

  private assertFeeLimitSufficient(
    transaction: InspectedTransaction,
    minimumFeeLimitSun: bigint,
    maximumFeeLimitSun: bigint
  ): void {
    if (transaction.feeLimitSun > maximumFeeLimitSun) {
      throw new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "The signed fee_limit exceeds the current chain maximum",
        "FEE_LIMIT_EXCEEDS_CHAIN_MAXIMUM"
      );
    }
    if (transaction.feeLimitSun < minimumFeeLimitSun) {
      throw new GatewayError(
        ReturnCode.CONTRACT_VALIDATE_ERROR,
        "The signed fee_limit cannot cover the safe total ENERGY requirement",
        "INSUFFICIENT_FEE_LIMIT_FOR_ENERGY"
      );
    }
  }

  private async delegate(transaction: InspectedTransaction, requirement: ResourceRequirement): Promise<void> {
    const maximum = await this.node.getCanDelegatedMaxSize(
      this.options.resourceOwnerAddress,
      requirement.resourceType
    );
    if (maximum < requirement.balanceSun) {
      throw new GatewayError(
        requirement.resourceType === "BANDWIDTH" ? ReturnCode.BANDWITH_ERROR : ReturnCode.CONTRACT_VALIDATE_ERROR,
        `Resource pool has insufficient ${requirement.resourceType}`,
        `INSUFFICIENT_${requirement.resourceType}`
      );
    }

    const lease = await this.repository.createLease({
      txId: transaction.txId,
      resourceType: requirement.resourceType,
      resourceOwnerAddress: this.options.resourceOwnerAddress,
      receiverAddress: transaction.ownerAddress,
      balanceSun: requirement.balanceSun
    });
    let broadcastPrepared = false;
    try {
      const unsigned = await this.node.buildDelegation({
        ownerAddress: this.options.resourceOwnerAddress,
        receiverAddress: transaction.ownerAddress,
        resourceType: requirement.resourceType,
        balanceSun: requirement.balanceSun
      });
      const signed = await this.signer.sign(unsigned);
      const txId = transactionId(signed);
      await this.repository.markLeaseDelegateBroadcast(lease.id, txId);
      broadcastPrepared = true;
      await this.node.broadcastTransaction(signed);
      const receipt = await this.node.waitForFullNodeReceipt(
        txId,
        this.options.delegationConfirmTimeoutMs,
        this.options.delegationPollMs
      );
      assertSuccessfulReceipt(receipt, "Resource delegation failed");
      await this.repository.markLeaseDelegated(lease.id, txId);
      logger.info(
        {
          sponsoredTxId: transaction.txId,
          delegateTxId: txId,
          resourceType: requirement.resourceType,
          balanceSun: requirement.balanceSun.toString()
        },
        "resource lease activated"
      );
    } catch (error) {
      if (broadcastPrepared) await this.repository.retryLeaseRelease(lease.id, errorMessage(error));
      else await this.repository.failLease(lease.id, errorMessage(error));
      throw error;
    }
  }
}

export class PaidProviderOrderError extends GatewayError {
  readonly providerOrderMayBeCharged = true;

  constructor(returnCode: number, publicMessage: string, internalCode: string, options?: ErrorOptions) {
    super(returnCode, publicMessage, internalCode, options);
    this.name = "PaidProviderOrderError";
  }
}

async function bestEffortProviderState(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.error({ err: error }, "provider order state update failed; manual reconciliation may be required");
  }
}

async function bestEffortResourceAudit(
  operation: () => Promise<unknown>,
  txId: string,
  stage: string
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.error(
      { err: error, txId, stage },
      "resource audit write failed without changing the paid transaction control flow"
    );
  }
}

function transactionId(transaction: Record<string, unknown>): string {
  const candidate = transaction.txID ?? transaction.txid;
  if (typeof candidate !== "string" || !/^[0-9a-f]{64}$/i.test(candidate)) {
    throw new Error("Signed resource transaction did not contain a valid txID");
  }
  return candidate.toLowerCase();
}

function assertSuccessfulReceipt(receipt: Record<string, unknown>, message: string): void {
  if (!isSuccessfulReceipt(receipt)) {
    const receiptBody = receipt.receipt as Record<string, unknown> | undefined;
    const result = String(receipt.result ?? receiptBody?.result ?? "UNKNOWN").toUpperCase();
    throw new Error(`${message}: ${result}`);
  }
}

function isSuccessfulReceipt(receipt: Record<string, unknown>): boolean {
  const receiptBody = receipt.receipt as Record<string, unknown> | undefined;
  const result = String(receipt.result ?? receiptBody?.result ?? "SUCCESS").toUpperCase();
  return result === "SUCCESS";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeEnergyNumber(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 1) {
    throw new GatewayError(
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "Estimated energy is outside the supported provider range",
      "ENERGY_PROVIDER_AMOUNT_UNSAFE"
    );
  }
  return converted;
}

function minimumBigInt(first: bigint, second: bigint): bigint {
  return first < second ? first : second;
}

function assertExternalEnergyReceiver(account: Record<string, unknown>, expectedAddress: string): void {
  if (account.address !== expectedAddress) {
    throw new GatewayError(
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "The external energy receiver account is not activated",
      "ENERGY_RECEIVER_NOT_ACTIVATED"
    );
  }
  if (account.type === "Contract" || account.type === 2 || account.type === "2") {
    throw new GatewayError(
      ReturnCode.CONTRACT_VALIDATE_ERROR,
      "A contract address cannot receive external energy sponsorship",
      "ENERGY_RECEIVER_IS_CONTRACT"
    );
  }
}

function assertSingleOwnerPermission(
  account: Record<string, unknown>,
  expectedAddress: string
): void {
  const permission = account.owner_permission ?? account.ownerPermission;
  if (permission === undefined || permission === null) return;
  if (typeof permission !== "object" || Array.isArray(permission)) {
    throw ownerPermissionError();
  }
  const record = permission as Record<string, unknown>;
  if (
    (record.id !== undefined && String(record.id) !== "0") ||
    (record.type !== undefined && record.type !== "Owner" && String(record.type) !== "0")
  ) {
    throw ownerPermissionError();
  }
  const threshold = positiveBigInt(record.threshold);
  const keys = record.keys;
  if (threshold === null || !Array.isArray(keys) || keys.length === 0) {
    throw ownerPermissionError();
  }
  let matchingWeight = 0n;
  for (const entry of keys) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw ownerPermissionError();
    }
    const key = entry as Record<string, unknown>;
    if (typeof key.address !== "string") throw ownerPermissionError();
    const weight = positiveBigInt(key.weight);
    if (weight === null) throw ownerPermissionError();
    let normalized: string;
    try {
      normalized = normalizeTronAddress(key.address);
    } catch {
      throw ownerPermissionError();
    }
    if (normalized === expectedAddress && weight > matchingWeight) matchingWeight = weight;
  }
  if (matchingWeight < threshold) throw ownerPermissionError();
}

function positiveBigInt(value: unknown): bigint | null {
  try {
    if (value === undefined || value === null || value === "") return null;
    const parsed = BigInt(String(value));
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

function ownerPermissionError(): GatewayError {
  return new GatewayError(
    ReturnCode.SIGERROR,
    "The signed owner key does not satisfy the current on-chain owner permission",
    "OWNER_PERMISSION_MISMATCH"
  );
}
