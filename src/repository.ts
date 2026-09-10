import type pg from "pg";
import type {
  AddressBinding,
  BeginRequestResult,
  InspectedTransaction,
  LeaseRecord,
  ResourceRequirement,
  ResourceType
} from "./domain.js";

type BindingRow = {
  address: string;
  label: string | null;
  enabled: boolean;
  max_transactions: string | null;
  used_transactions: string;
  reserved_transactions: string;
  expires_at: Date | null;
};

type LeaseRow = {
  id: string;
  tx_id: string;
  resource_type: ResourceType;
  resource_owner_address: string;
  receiver_address: string;
  balance_sun: string;
  delegate_tx_id: string | null;
  undelegate_tx_id: string | null;
  state: string;
  release_after: Date | null;
  created_at: Date;
  updated_at: Date;
};

type BroadcastRequestRow = {
  tx_id: string;
  owner_address: string;
  contract_type: number;
  contract_address: string | null;
  function_selector: string | null;
  expiration_ms: string;
  state: string;
  energy_required: string | null;
  energy_deficit: string | null;
  bandwidth_required: string | null;
  bandwidth_deficit: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
} & ResourceAuditRow;

type ResourceAuditRow = {
  audit_tx_id: string | null;
  audit_energy_estimate_raw: string | null;
  audit_energy_estimate_safe: string | null;
  audit_estimate_safety_bps: number | null;
  audit_energy_available_before: string | null;
  audit_package_threshold: string | null;
  audit_energy_package_quoted: string | null;
  audit_energy_package_attempted: string | null;
  audit_energy_unit_price_sun: string | null;
  audit_estimated_energy_burn_sun: string | null;
  audit_bandwidth_bytes: string | null;
  audit_bandwidth_staked_available: string | null;
  audit_bandwidth_free_available: string | null;
  audit_bandwidth_source: string | null;
  audit_bandwidth_unit_price_sun: string | null;
  audit_estimated_bandwidth_burn_sun: string | null;
  audit_owner_balance_sun: string | null;
  audit_fee_limit_sun: string | null;
  audit_minimum_fee_limit_sun: string | null;
  audit_maximum_fee_limit_sun: string | null;
  audit_energy_available_after: string | null;
  audit_energy_arrival_delta: string | null;
  audit_receipt_energy_usage_total: string | null;
  audit_receipt_energy_usage: string | null;
  audit_receipt_origin_energy_usage: string | null;
  audit_receipt_net_usage: string | null;
  audit_receipt_net_fee_sun: string | null;
  audit_receipt_energy_fee_sun: string | null;
  audit_receipt_total_fee_sun: string | null;
  audit_receipt_result: string | null;
  audit_planned_at: Date | null;
  audit_energy_arrival_observed_at: Date | null;
  audit_solidified_at: Date | null;
  audit_created_at: Date | null;
  audit_updated_at: Date | null;
};

export type ResourceAuditPlan = {
  energyEstimateRaw: bigint;
  energyEstimateSafe: bigint;
  estimateSafetyBps: number;
  energyAvailableBefore: bigint;
  packageThreshold: bigint;
  energyPackageQuoted: bigint | null;
  energyPriceSun: bigint;
  estimatedEnergyBurnSun: bigint;
  bandwidthBytes: bigint;
  bandwidthStakedAvailable: bigint;
  bandwidthFreeAvailable: bigint;
  bandwidthSource: "STAKED" | "FREE" | "TRX";
  bandwidthUnitPriceSun: bigint;
  estimatedBandwidthBurnSun: bigint;
  ownerBalanceSun: bigint;
  feeLimitSun: bigint;
  minimumFeeLimitSun: bigint;
  maximumFeeLimitSun: bigint;
};

export type ResourceAuditSummary = {
  energyEstimateRaw: bigint | null;
  energyEstimateSafe: bigint | null;
  estimateSafetyBps: number | null;
  energyAvailableBefore: bigint | null;
  packageThreshold: bigint | null;
  energyPackageQuoted: bigint | null;
  energyPackageAttempted: bigint | null;
  energyPriceSun: bigint | null;
  estimatedEnergyBurnSun: bigint | null;
  bandwidthBytes: bigint | null;
  bandwidthStakedAvailable: bigint | null;
  bandwidthFreeAvailable: bigint | null;
  bandwidthSource: string | null;
  bandwidthUnitPriceSun: bigint | null;
  estimatedBandwidthBurnSun: bigint | null;
  ownerBalanceSun: bigint | null;
  feeLimitSun: bigint | null;
  minimumFeeLimitSun: bigint | null;
  maximumFeeLimitSun: bigint | null;
  energyAvailableAfter: bigint | null;
  energyArrivalDelta: bigint | null;
  receiptEnergyUsageTotal: bigint | null;
  receiptEnergyUsage: bigint | null;
  receiptOriginEnergyUsage: bigint | null;
  receiptNetUsage: bigint | null;
  receiptNetFeeSun: bigint | null;
  receiptEnergyFeeSun: bigint | null;
  receiptTotalFeeSun: bigint | null;
  receiptResult: string | null;
  plannedAt: Date | null;
  energyArrivalObservedAt: Date | null;
  solidifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BroadcastRequestSummary = {
  txId: string;
  ownerAddress: string;
  contractType: number;
  contractAddress: string | null;
  functionSelector: string | null;
  expirationMs: bigint;
  state: string;
  energyRequired: bigint | null;
  energyDeficit: bigint | null;
  bandwidthRequired: bigint | null;
  bandwidthDeficit: bigint | null;
  errorCode: string | null;
  errorMessage: string | null;
  audit: ResourceAuditSummary | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GatewayDatabaseStats = {
  bindingsTotal: bigint;
  bindingsEnabled: bigint;
  requestsTotal: bigint;
  leasesTotal: bigint;
  requestsByState: Record<string, bigint>;
  leasesByState: Record<string, bigint>;
};

const resourceAuditColumns = `
  a.tx_id AS audit_tx_id,
  a.energy_estimate_raw AS audit_energy_estimate_raw,
  a.energy_estimate_safe AS audit_energy_estimate_safe,
  a.estimate_safety_bps AS audit_estimate_safety_bps,
  a.energy_available_before AS audit_energy_available_before,
  a.package_threshold AS audit_package_threshold,
  a.energy_package_quoted AS audit_energy_package_quoted,
  a.energy_package_attempted AS audit_energy_package_attempted,
  a.energy_unit_price_sun AS audit_energy_unit_price_sun,
  a.estimated_energy_burn_sun AS audit_estimated_energy_burn_sun,
  a.bandwidth_bytes AS audit_bandwidth_bytes,
  a.bandwidth_staked_available AS audit_bandwidth_staked_available,
  a.bandwidth_free_available AS audit_bandwidth_free_available,
  a.bandwidth_source AS audit_bandwidth_source,
  a.bandwidth_unit_price_sun AS audit_bandwidth_unit_price_sun,
  a.estimated_bandwidth_burn_sun AS audit_estimated_bandwidth_burn_sun,
  a.owner_balance_sun AS audit_owner_balance_sun,
  a.fee_limit_sun AS audit_fee_limit_sun,
  a.minimum_fee_limit_sun AS audit_minimum_fee_limit_sun,
  a.maximum_fee_limit_sun AS audit_maximum_fee_limit_sun,
  a.energy_available_after AS audit_energy_available_after,
  a.energy_arrival_delta AS audit_energy_arrival_delta,
  a.receipt_energy_usage_total AS audit_receipt_energy_usage_total,
  a.receipt_energy_usage AS audit_receipt_energy_usage,
  a.receipt_origin_energy_usage AS audit_receipt_origin_energy_usage,
  a.receipt_net_usage AS audit_receipt_net_usage,
  a.receipt_net_fee_sun AS audit_receipt_net_fee_sun,
  a.receipt_energy_fee_sun AS audit_receipt_energy_fee_sun,
  a.receipt_total_fee_sun AS audit_receipt_total_fee_sun,
  a.receipt_result AS audit_receipt_result,
  a.planned_at AS audit_planned_at,
  a.energy_arrival_observed_at AS audit_energy_arrival_observed_at,
  a.solidified_at AS audit_solidified_at,
  a.created_at AS audit_created_at,
  a.updated_at AS audit_updated_at`;

export class GatewayRepository {
  constructor(private readonly pool: pg.Pool) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async getDashboardStats(): Promise<GatewayDatabaseStats> {
    const [totals, requestStates, leaseStates] = await Promise.all([
      this.pool.query<{
        bindings_total: string;
        bindings_enabled: string;
        requests_total: string;
        leases_total: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM address_bindings) AS bindings_total,
           (SELECT COUNT(*)::text FROM address_bindings WHERE enabled) AS bindings_enabled,
           (SELECT COUNT(*)::text FROM broadcast_requests) AS requests_total,
           (SELECT COUNT(*)::text FROM resource_leases) AS leases_total`
      ),
      this.pool.query<{ state: string; count: string }>(
        `SELECT state, COUNT(*)::text AS count
           FROM broadcast_requests
          GROUP BY state
          ORDER BY state`
      ),
      this.pool.query<{ state: string; count: string }>(
        `SELECT state, COUNT(*)::text AS count
           FROM resource_leases
          GROUP BY state
          ORDER BY state`
      )
    ]);
    const row = totals.rows[0];
    if (!row) throw new Error("Database statistics query returned no row");
    return {
      bindingsTotal: BigInt(row.bindings_total),
      bindingsEnabled: BigInt(row.bindings_enabled),
      requestsTotal: BigInt(row.requests_total),
      leasesTotal: BigInt(row.leases_total),
      requestsByState: Object.fromEntries(
        requestStates.rows.map((entry) => [entry.state, BigInt(entry.count)])
      ),
      leasesByState: Object.fromEntries(
        leaseStates.rows.map((entry) => [entry.state, BigInt(entry.count)])
      )
    };
  }

  async getBinding(address: string): Promise<AddressBinding | null> {
    const result = await this.pool.query<BindingRow>(
      `SELECT address, label, enabled, max_transactions, used_transactions,
              reserved_transactions, expires_at
         FROM address_bindings
        WHERE address = $1`,
      [address]
    );
    const row = result.rows[0];
    return row ? mapBinding(row) : null;
  }

  async listBindings(): Promise<AddressBinding[]> {
    const result = await this.pool.query<BindingRow>(
      `SELECT address, label, enabled, max_transactions, used_transactions,
              reserved_transactions, expires_at
         FROM address_bindings
        ORDER BY created_at DESC`
    );
    return result.rows.map(mapBinding);
  }

  async upsertBinding(input: {
    address: string;
    label?: string | null;
    maxTransactions?: bigint | null;
    expiresAt?: Date | null;
    enabled?: boolean;
  }): Promise<AddressBinding> {
    assertBindingTransactionLimit(input.maxTransactions);
    const result = await this.pool.query<BindingRow>(
      `INSERT INTO address_bindings(address, label, max_transactions, expires_at, enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (address) DO UPDATE SET
         label = CASE WHEN $6::boolean THEN EXCLUDED.label ELSE address_bindings.label END,
         max_transactions = CASE WHEN $7::boolean THEN EXCLUDED.max_transactions ELSE address_bindings.max_transactions END,
         expires_at = CASE WHEN $8::boolean THEN EXCLUDED.expires_at ELSE address_bindings.expires_at END,
         enabled = CASE WHEN $9::boolean THEN EXCLUDED.enabled ELSE address_bindings.enabled END,
         updated_at = NOW()
       RETURNING address, label, enabled, max_transactions, used_transactions,
                 reserved_transactions, expires_at`,
      [
        input.address,
        input.label ?? null,
        input.maxTransactions?.toString() ?? null,
        input.expiresAt ?? null,
        input.enabled ?? true,
        input.label !== undefined,
        input.maxTransactions !== undefined,
        input.expiresAt !== undefined,
        input.enabled !== undefined
      ]
    );
    return mapBinding(result.rows[0]!);
  }

  async setBindingEnabled(address: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE address_bindings SET enabled = $2, updated_at = NOW() WHERE address = $1",
      [address, enabled]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resetBindingUsage(
    address: string,
    maxTransactions?: bigint | null,
    requireNoPaidActivity = false
  ): Promise<AddressBinding | null> {
    assertBindingTransactionLimit(maxTransactions);
    const replaceMaximum = maxTransactions !== undefined;
    const result = await this.pool.query<BindingRow>(
      `UPDATE address_bindings SET
         used_transactions = 0,
         max_transactions = CASE WHEN $2::boolean THEN $3::bigint ELSE max_transactions END,
         updated_at = NOW()
       WHERE address = $1
         AND reserved_transactions = 0
         AND (
           NOT $4::boolean
           OR (
             NOT EXISTS (
               SELECT 1 FROM sponsor_address_claims c
                WHERE c.owner_address = address_bindings.address
             )
             AND NOT EXISTS (
               SELECT 1 FROM energy_provider_orders e
                WHERE e.receive_address = address_bindings.address
                  AND e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')
             )
           )
         )
       RETURNING address, label, enabled, max_transactions, used_transactions,
                 reserved_transactions, expires_at`,
      [address, replaceMaximum, maxTransactions?.toString() ?? null, requireNoPaidActivity]
    );
    return result.rows[0] ? mapBinding(result.rows[0]) : null;
  }

  async beginRequest(transaction: InspectedTransaction): Promise<BeginRequestResult> {
    const inserted = await this.pool.query(
      `INSERT INTO broadcast_requests(
         tx_id, owner_address, contract_type, contract_address,
         function_selector, expiration_ms, state
       ) VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVED')
       ON CONFLICT (tx_id) DO NOTHING
       RETURNING tx_id`,
      [
        transaction.txId,
        transaction.ownerAddress,
        transaction.contractType,
        transaction.contractAddress ?? null,
        transaction.functionSelector ?? null,
        transaction.expirationMs.toString()
      ]
    );
    if ((inserted.rowCount ?? 0) > 0) return { kind: "created" };

    const existing = await this.pool.query<{
      state: string;
      upstream_response: Buffer | null;
      upstream_grpc_status: string | null;
    }>(
      `SELECT state, upstream_response, upstream_grpc_status
         FROM broadcast_requests
        WHERE tx_id = $1`,
      [transaction.txId]
    );
    const row = existing.rows[0];
    if (row?.upstream_response) {
      return {
        kind: "cached",
        response: row.upstream_response,
        grpcStatus: row.upstream_grpc_status ?? "0"
      };
    }
    return { kind: "in_progress", state: row?.state ?? "UNKNOWN" };
  }

  async tryAcquireAddressClaim(ownerAddress: string, txId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO sponsor_address_claims(owner_address, tx_id)
       SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM energy_provider_orders e
           WHERE e.receive_address = $1
             AND e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')
        )
       ON CONFLICT (owner_address) DO NOTHING
       RETURNING owner_address`,
      [ownerAddress, txId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseAddressClaim(ownerAddress: string, txId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM sponsor_address_claims AS c
        WHERE c.owner_address = $1
          AND c.tx_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM energy_provider_orders e
             WHERE e.tx_id = c.tx_id
               AND e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')
          )
          AND NOT EXISTS (
            SELECT 1 FROM resource_leases l
             WHERE l.tx_id = c.tx_id
               AND l.state NOT IN ('RELEASED', 'FAILED', 'FAILED_NO_DELEGATION')
          )`,
      [ownerAddress, txId]
    );
  }

  async discardUnpreparedRequest(txId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM broadcast_requests AS b
        WHERE b.tx_id = $1
          AND b.state = 'RECEIVED'
          AND b.quota_reserved = FALSE
          AND NOT EXISTS (SELECT 1 FROM sponsor_address_claims c WHERE c.tx_id = b.tx_id)
          AND NOT EXISTS (SELECT 1 FROM resource_leases l WHERE l.tx_id = b.tx_id)
          AND NOT EXISTS (SELECT 1 FROM energy_provider_orders e WHERE e.tx_id = b.tx_id)`,
      [txId]
    );
  }

  async releaseTerminalAddressClaims(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM sponsor_address_claims AS c
        USING broadcast_requests AS b
        WHERE c.tx_id = b.tx_id
          AND b.state IN (
            'REJECTED', 'FAILED', 'UPSTREAM_REJECTED',
            'SOLIDIFIED_SUCCESS', 'SOLIDIFIED_FAILED', 'EXPIRED'
          )
          AND NOT EXISTS (
            SELECT 1 FROM energy_provider_orders e
             WHERE e.tx_id = c.tx_id
               AND e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')
          )
          AND NOT EXISTS (
            SELECT 1 FROM resource_leases l
             WHERE l.tx_id = c.tx_id
               AND l.state NOT IN ('RELEASED', 'FAILED', 'FAILED_NO_DELEGATION')
          )`
    );
    return result.rowCount ?? 0;
  }

  async hasOpenPaidProviderActivity(ownerAddress: string): Promise<boolean> {
    const result = await this.pool.query<{ present: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM sponsor_address_claims c
            WHERE c.owner_address = $1
         ) OR EXISTS (
           SELECT 1 FROM energy_provider_orders e
            WHERE e.receive_address = $1
              AND e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')
         )
       ) AS present`,
      [ownerAddress]
    );
    return result.rows[0]?.present === true;
  }

  async updateRequirements(txId: string, requirements: readonly ResourceRequirement[]): Promise<void> {
    const energy = requirements.find((entry) => entry.resourceType === "ENERGY");
    const bandwidth = requirements.find((entry) => entry.resourceType === "BANDWIDTH");
    await this.pool.query(
      `UPDATE broadcast_requests SET
         energy_required = $2,
         energy_deficit = $3,
         bandwidth_required = $4,
         bandwidth_deficit = $5,
         state = 'RESOURCE_ESTIMATED',
         updated_at = NOW()
       WHERE tx_id = $1`,
      [
        txId,
        energy?.required.toString() ?? null,
        energy?.deficit.toString() ?? null,
        bandwidth?.required.toString() ?? null,
        bandwidth?.deficit.toString() ?? null
      ]
    );
  }

  async upsertResourceAuditPlan(txId: string, plan: ResourceAuditPlan): Promise<void> {
    assertResourceAuditPlan(plan);
    await this.pool.query(
       `INSERT INTO transaction_resource_audits(
         tx_id, energy_estimate_raw, energy_estimate_safe, estimate_safety_bps,
         energy_available_before, package_threshold, energy_package_quoted, energy_unit_price_sun,
         estimated_energy_burn_sun, bandwidth_bytes, bandwidth_staked_available,
         bandwidth_free_available, bandwidth_source, bandwidth_unit_price_sun,
         estimated_bandwidth_burn_sun, owner_balance_sun, fee_limit_sun,
         minimum_fee_limit_sun, maximum_fee_limit_sun, planned_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()
       )
       ON CONFLICT (tx_id) DO UPDATE SET
         energy_estimate_raw = EXCLUDED.energy_estimate_raw,
         energy_estimate_safe = EXCLUDED.energy_estimate_safe,
         estimate_safety_bps = EXCLUDED.estimate_safety_bps,
         energy_available_before = EXCLUDED.energy_available_before,
         package_threshold = EXCLUDED.package_threshold,
         energy_package_quoted = EXCLUDED.energy_package_quoted,
         energy_unit_price_sun = EXCLUDED.energy_unit_price_sun,
         estimated_energy_burn_sun = EXCLUDED.estimated_energy_burn_sun,
         bandwidth_bytes = EXCLUDED.bandwidth_bytes,
         bandwidth_staked_available = EXCLUDED.bandwidth_staked_available,
         bandwidth_free_available = EXCLUDED.bandwidth_free_available,
         bandwidth_source = EXCLUDED.bandwidth_source,
         bandwidth_unit_price_sun = EXCLUDED.bandwidth_unit_price_sun,
         estimated_bandwidth_burn_sun = EXCLUDED.estimated_bandwidth_burn_sun,
         owner_balance_sun = EXCLUDED.owner_balance_sun,
         fee_limit_sun = EXCLUDED.fee_limit_sun,
         minimum_fee_limit_sun = EXCLUDED.minimum_fee_limit_sun,
         maximum_fee_limit_sun = EXCLUDED.maximum_fee_limit_sun,
         planned_at = NOW(),
         updated_at = NOW()`,
      [
        txId,
        plan.energyEstimateRaw.toString(),
        plan.energyEstimateSafe.toString(),
        plan.estimateSafetyBps,
        plan.energyAvailableBefore.toString(),
        plan.packageThreshold.toString(),
        plan.energyPackageQuoted?.toString() ?? null,
        plan.energyPriceSun.toString(),
        plan.estimatedEnergyBurnSun.toString(),
        plan.bandwidthBytes.toString(),
        plan.bandwidthStakedAvailable.toString(),
        plan.bandwidthFreeAvailable.toString(),
        plan.bandwidthSource,
        plan.bandwidthUnitPriceSun.toString(),
        plan.estimatedBandwidthBurnSun.toString(),
        plan.ownerBalanceSun.toString(),
        plan.feeLimitSun.toString(),
        plan.minimumFeeLimitSun.toString(),
        plan.maximumFeeLimitSun.toString()
      ]
    );
  }

  async recordEnergyPackageAttempt(txId: string, amount: bigint): Promise<void> {
    assertNonnegativeBigInt(amount, "amount");
    if (amount === 0n) throw new RangeError("amount must be positive");
    await this.pool.query(
      `INSERT INTO transaction_resource_audits(
         tx_id, energy_package_attempted
       ) VALUES ($1, $2)
       ON CONFLICT (tx_id) DO UPDATE SET
         energy_package_attempted = EXCLUDED.energy_package_attempted,
         updated_at = NOW()`,
      [txId, amount.toString()]
    );
  }

  async recordEnergyArrival(txId: string, availableAfter: bigint): Promise<void> {
    assertNonnegativeBigInt(availableAfter, "availableAfter");
    await this.pool.query(
      `INSERT INTO transaction_resource_audits(
         tx_id, energy_available_after, energy_arrival_observed_at
       ) VALUES ($1, $2, NOW())
       ON CONFLICT (tx_id) DO UPDATE SET
         energy_available_after = CASE
           WHEN transaction_resource_audits.energy_available_after IS NULL
             OR EXCLUDED.energy_available_after > transaction_resource_audits.energy_available_after
           THEN EXCLUDED.energy_available_after
           ELSE transaction_resource_audits.energy_available_after
         END,
         energy_arrival_observed_at = CASE
           WHEN transaction_resource_audits.energy_available_after IS NULL
             OR EXCLUDED.energy_available_after > transaction_resource_audits.energy_available_after
           THEN NOW()
           ELSE transaction_resource_audits.energy_arrival_observed_at
         END,
         updated_at = NOW()`,
      [txId, availableAfter.toString()]
    );
  }

  async reserveQuota(address: string, txId: string, requireFiniteLimit = false): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const bindingResult = await client.query<BindingRow>(
        `SELECT address, label, enabled, max_transactions, used_transactions,
                reserved_transactions, expires_at
           FROM address_bindings
          WHERE address = $1
          FOR UPDATE`,
        [address]
      );
      const row = bindingResult.rows[0];
      if (!row || !row.enabled || (row.expires_at && row.expires_at.getTime() <= Date.now())) {
        await client.query("ROLLBACK");
        return false;
      }
      const max = row.max_transactions === null ? null : BigInt(row.max_transactions);
      const used = BigInt(row.used_transactions);
      const reserved = BigInt(row.reserved_transactions);
      if (requireFiniteLimit && max === null) {
        await client.query("ROLLBACK");
        return false;
      }
      if (max !== null && used + reserved >= max) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE address_bindings
            SET reserved_transactions = reserved_transactions + 1, updated_at = NOW()
          WHERE address = $1`,
        [address]
      );
      await client.query(
        `UPDATE broadcast_requests
            SET quota_reserved = TRUE, state = 'QUOTA_RESERVED', updated_at = NOW()
          WHERE tx_id = $1`,
        [txId]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeQuota(address: string, txId: string): Promise<void> {
    await this.moveQuota(address, txId, true);
  }

  async releaseQuota(address: string, txId: string): Promise<void> {
    await this.moveQuota(address, txId, false);
  }

  private async moveQuota(address: string, txId: string, consume: boolean): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await client.query<{ quota_reserved: boolean }>(
        "SELECT quota_reserved FROM broadcast_requests WHERE tx_id = $1 FOR UPDATE",
        [txId]
      );
      if (!request.rows[0]?.quota_reserved) {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        `UPDATE address_bindings SET
           reserved_transactions = GREATEST(0, reserved_transactions - 1),
           used_transactions = used_transactions + $2,
           updated_at = NOW()
         WHERE address = $1`,
        [address, consume ? 1 : 0]
      );
      await client.query(
        `UPDATE broadcast_requests
            SET quota_reserved = FALSE, updated_at = NOW()
          WHERE tx_id = $1`,
        [txId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setRequestState(txId: string, state: string): Promise<void> {
    await this.pool.query(
      "UPDATE broadcast_requests SET state = $2, updated_at = NOW() WHERE tx_id = $1",
      [txId, state]
    );
  }

  async completeRequest(
    txId: string,
    state: string,
    response: Buffer,
    grpcStatus: string,
    errorCode: string | null = null,
    errorMessage: string | null = null
  ): Promise<void> {
    await this.pool.query(
      `UPDATE broadcast_requests SET
         state = $2,
         upstream_response = $3,
         upstream_grpc_status = $4,
         error_code = $5,
         error_message = $6,
         updated_at = NOW()
       WHERE tx_id = $1`,
      [txId, state, response, grpcStatus, errorCode, errorMessage?.slice(0, 1_000) ?? null]
    );
  }

  async recordBroadcastOutcome(input: {
    txId: string;
    ownerAddress: string;
    accepted: boolean;
    response: Buffer;
    grpcStatus: string;
    reclaimDelayMs: number;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await client.query<{ quota_reserved: boolean; provider_billable: boolean }>(
        `SELECT b.quota_reserved,
                EXISTS (
                  SELECT 1 FROM energy_provider_orders e
                   WHERE e.tx_id = b.tx_id
                     AND e.state IN ('ORDERING', 'ACCEPTED', 'FULFILLED', 'UNKNOWN')
                ) AS provider_billable
           FROM broadcast_requests b
          WHERE b.tx_id = $1
          FOR UPDATE`,
        [input.txId]
      );
      const quota = request.rows[0];
      if (quota?.quota_reserved) {
        const consume = input.accepted || quota.provider_billable;
        await client.query(
          `UPDATE address_bindings SET
             reserved_transactions = GREATEST(0, reserved_transactions - 1),
             used_transactions = used_transactions + $2,
             updated_at = NOW()
           WHERE address = $1`,
          [input.ownerAddress, consume ? 1 : 0]
        );
      }
      await client.query(
        `UPDATE broadcast_requests SET
           state = $2,
           quota_reserved = FALSE,
           upstream_response = $3,
           upstream_grpc_status = $4,
           error_code = $5,
           error_message = $6,
           updated_at = NOW()
         WHERE tx_id = $1`,
        [
          input.txId,
          input.accepted ? "UPSTREAM_ACCEPTED" : "UPSTREAM_REJECTED",
          input.response,
          input.grpcStatus,
          input.accepted ? null : input.errorCode ?? null,
          input.accepted ? null : input.errorMessage?.slice(0, 1_000) ?? null
        ]
      );
      if (!input.accepted) {
        await client.query(
          `UPDATE resource_leases
              SET state = 'RELEASE_PENDING',
                  release_after = NOW() + ($2 * INTERVAL '1 millisecond'),
                  updated_at = NOW()
            WHERE tx_id = $1 AND state = 'ACTIVE'`,
          [input.txId, input.reclaimDelayMs]
        );
        await client.query(
          `DELETE FROM sponsor_address_claims AS c
            WHERE c.tx_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM energy_provider_orders e
                 WHERE e.tx_id = c.tx_id
                   AND e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')
              )
              AND NOT EXISTS (
                SELECT 1 FROM resource_leases l
                 WHERE l.tx_id = c.tx_id
                   AND l.state NOT IN ('RELEASED', 'FAILED', 'FAILED_NO_DELEGATION')
              )`,
          [input.txId]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failRequest(txId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.pool.query(
      `UPDATE broadcast_requests SET
         state = 'FAILED', error_code = $2, error_message = $3, updated_at = NOW()
       WHERE tx_id = $1`,
      [txId, errorCode, errorMessage.slice(0, 1_000)]
    );
  }

  async createLease(input: {
    txId: string;
    resourceType: ResourceType;
    resourceOwnerAddress: string;
    receiverAddress: string;
    balanceSun: bigint;
  }): Promise<LeaseRecord> {
    const result = await this.pool.query<LeaseRow>(
      `INSERT INTO resource_leases(
         tx_id, resource_type, resource_owner_address, receiver_address,
         balance_sun, state
       ) VALUES ($1, $2, $3, $4, $5, 'CREATED')
       RETURNING *`,
      [
        input.txId,
        input.resourceType,
        input.resourceOwnerAddress,
        input.receiverAddress,
        input.balanceSun.toString()
      ]
    );
    return mapLease(result.rows[0]!);
  }

  async markLeaseDelegated(id: bigint, delegateTxId: string): Promise<void> {
    await this.pool.query(
      `UPDATE resource_leases
          SET delegate_tx_id = $2, state = 'ACTIVE', updated_at = NOW()
        WHERE id = $1`,
      [id.toString(), delegateTxId]
    );
  }

  async markLeaseDelegateBroadcast(id: bigint, delegateTxId: string): Promise<void> {
    await this.pool.query(
      `UPDATE resource_leases
          SET delegate_tx_id = $2, state = 'DELEGATING', updated_at = NOW()
        WHERE id = $1`,
      [id.toString(), delegateTxId]
    );
  }

  async markLeaseUndelegateBroadcast(id: bigint, undelegateTxId: string): Promise<void> {
    await this.pool.query(
      `UPDATE resource_leases
          SET undelegate_tx_id = $2, state = 'RELEASE_BROADCAST', updated_at = NOW()
        WHERE id = $1`,
      [id.toString(), undelegateTxId]
    );
  }

  async failLease(id: bigint, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE resource_leases
          SET state = 'FAILED', error_message = $2, updated_at = NOW()
        WHERE id = $1`,
      [id.toString(), message.slice(0, 1_000)]
    );
  }

  async listRequestsAwaitingFinality(limit = 50): Promise<Array<{ txId: string; expirationMs: bigint }>> {
    const result = await this.pool.query<{ tx_id: string; expiration_ms: string }>(
      `SELECT tx_id, expiration_ms
         FROM broadcast_requests
        WHERE state = 'UPSTREAM_ACCEPTED'
        ORDER BY updated_at ASC
        LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({ txId: row.tx_id, expirationMs: BigInt(row.expiration_ms) }));
  }

  async listStaleRequests(limit = 50): Promise<
    Array<{ txId: string; ownerAddress: string; expirationMs: bigint; quotaReserved: boolean }>
  > {
    const result = await this.pool.query<{
      tx_id: string;
      owner_address: string;
      expiration_ms: string;
      quota_reserved: boolean;
    }>(
      `SELECT tx_id, owner_address, expiration_ms, quota_reserved
         FROM broadcast_requests
        WHERE (
               state IN ('RECEIVED', 'QUOTA_RESERVED', 'RESOURCE_ESTIMATED', 'RESOURCE_READY')
               OR (state = 'FAILED' AND quota_reserved = TRUE)
              )
          AND updated_at < NOW() - INTERVAL '2 minutes'
        ORDER BY updated_at ASC
        LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      txId: row.tx_id,
      ownerAddress: row.owner_address,
      expirationMs: BigInt(row.expiration_ms),
      quotaReserved: row.quota_reserved
    }));
  }

  async markFinalized(
    txId: string,
    success: boolean,
    reclaimDelayMs: number,
    receipt: Record<string, unknown>
  ): Promise<void> {
    const receiptAudit = summarizeSolidifiedReceipt(receipt, success);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE broadcast_requests
            SET state = $2, updated_at = NOW()
          WHERE tx_id = $1`,
        [txId, success ? "SOLIDIFIED_SUCCESS" : "SOLIDIFIED_FAILED"]
      );
      await client.query(
        `INSERT INTO transaction_resource_audits(
           tx_id, receipt_energy_usage_total, receipt_energy_usage,
           receipt_origin_energy_usage, receipt_net_usage, receipt_net_fee_sun,
           receipt_energy_fee_sun, receipt_total_fee_sun, receipt_result, solidified_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (tx_id) DO UPDATE SET
           receipt_energy_usage_total = COALESCE(
             EXCLUDED.receipt_energy_usage_total,
             transaction_resource_audits.receipt_energy_usage_total
           ),
           receipt_energy_usage = COALESCE(
             EXCLUDED.receipt_energy_usage,
             transaction_resource_audits.receipt_energy_usage
           ),
           receipt_origin_energy_usage = COALESCE(
             EXCLUDED.receipt_origin_energy_usage,
             transaction_resource_audits.receipt_origin_energy_usage
           ),
           receipt_net_usage = COALESCE(
             EXCLUDED.receipt_net_usage,
             transaction_resource_audits.receipt_net_usage
           ),
           receipt_net_fee_sun = COALESCE(
             EXCLUDED.receipt_net_fee_sun,
             transaction_resource_audits.receipt_net_fee_sun
           ),
           receipt_energy_fee_sun = COALESCE(
             EXCLUDED.receipt_energy_fee_sun,
             transaction_resource_audits.receipt_energy_fee_sun
           ),
           receipt_total_fee_sun = COALESCE(
             EXCLUDED.receipt_total_fee_sun,
             transaction_resource_audits.receipt_total_fee_sun
           ),
           receipt_result = EXCLUDED.receipt_result,
           solidified_at = NOW(),
           updated_at = NOW()`,
        [
          txId,
          databaseBigInt(receiptAudit.energyUsageTotal),
          databaseBigInt(receiptAudit.energyUsage),
          databaseBigInt(receiptAudit.originEnergyUsage),
          databaseBigInt(receiptAudit.netUsage),
          databaseBigInt(receiptAudit.netFeeSun),
          databaseBigInt(receiptAudit.energyFeeSun),
          databaseBigInt(receiptAudit.totalFeeSun),
          receiptAudit.result
        ]
      );
      await client.query(
        `UPDATE resource_leases
            SET state = 'RELEASE_PENDING',
                release_after = NOW() + ($2 * INTERVAL '1 millisecond'),
                updated_at = NOW()
          WHERE tx_id = $1 AND state = 'ACTIVE'`,
        [txId, reclaimDelayMs]
      );
      await client.query(
        `DELETE FROM sponsor_address_claims AS c
          WHERE c.tx_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM energy_provider_orders e
               WHERE e.tx_id = c.tx_id
                 AND e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')
            )
            AND NOT EXISTS (
              SELECT 1 FROM resource_leases l
               WHERE l.tx_id = c.tx_id
                 AND l.state NOT IN ('RELEASED', 'FAILED', 'FAILED_NO_DELEGATION')
            )`,
        [txId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async expireRequest(txId: string, reclaimDelayMs: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE broadcast_requests SET state = 'EXPIRED', updated_at = NOW() WHERE tx_id = $1",
        [txId]
      );
      await client.query(
        `UPDATE resource_leases
            SET state = 'RELEASE_PENDING',
                release_after = NOW() + ($2 * INTERVAL '1 millisecond'),
                updated_at = NOW()
          WHERE tx_id = $1 AND state = 'ACTIVE'`,
        [txId, reclaimDelayMs]
      );
      await client.query(
        `DELETE FROM sponsor_address_claims AS c
          WHERE c.tx_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM energy_provider_orders e
               WHERE e.tx_id = c.tx_id
                 AND e.state IN ('ORDERING', 'ACCEPTED', 'UNKNOWN')
            )
            AND NOT EXISTS (
              SELECT 1 FROM resource_leases l
               WHERE l.tx_id = c.tx_id
                 AND l.state NOT IN ('RELEASED', 'FAILED', 'FAILED_NO_DELEGATION')
            )`,
        [txId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async scheduleLeasesForRelease(
    txId: string,
    reclaimDelayMs: number,
    requestState?: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (requestState) {
        await client.query(
          "UPDATE broadcast_requests SET state = $2, updated_at = NOW() WHERE tx_id = $1",
          [txId, requestState]
        );
      }
      await client.query(
        `UPDATE resource_leases
            SET state = 'RELEASE_PENDING',
                release_after = NOW() + ($2 * INTERVAL '1 millisecond'),
                updated_at = NOW()
          WHERE tx_id = $1 AND state = 'ACTIVE'`,
        [txId, reclaimDelayMs]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listLeasesReadyToRelease(limit = 20): Promise<LeaseRecord[]> {
    const result = await this.pool.query<LeaseRow>(
      `SELECT * FROM resource_leases
        WHERE state = 'RELEASE_PENDING' AND release_after <= NOW()
        ORDER BY release_after ASC
        LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapLease);
  }

  async claimLeaseForRelease(id: bigint): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE resource_leases
          SET state = 'RELEASING', updated_at = NOW()
        WHERE id = $1 AND state = 'RELEASE_PENDING'`,
      [id.toString()]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markLeaseReleased(id: bigint, undelegateTxId: string): Promise<void> {
    await this.pool.query(
      `UPDATE resource_leases
          SET state = 'RELEASED', undelegate_tx_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [id.toString(), undelegateTxId]
    );
  }

  async markLeaseWithoutDelegation(id: bigint, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE resource_leases
          SET state = 'FAILED_NO_DELEGATION', error_message = $2, updated_at = NOW()
        WHERE id = $1`,
      [id.toString(), message.slice(0, 1_000)]
    );
  }

  async listReleaseBroadcasts(limit = 20): Promise<LeaseRecord[]> {
    const result = await this.pool.query<LeaseRow>(
      `SELECT * FROM resource_leases
        WHERE state = 'RELEASE_BROADCAST'
        ORDER BY updated_at ASC
        LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapLease);
  }

  async retryLeaseRelease(id: bigint, errorMessage: string): Promise<void> {
    await this.pool.query(
      `UPDATE resource_leases
          SET state = 'RELEASE_PENDING', release_after = NOW() + INTERVAL '30 seconds',
              error_message = $2, updated_at = NOW()
        WHERE id = $1`,
      [id.toString(), errorMessage.slice(0, 1_000)]
    );
  }

  async getRequest(txId: string): Promise<BroadcastRequestSummary | null> {
    const result = await this.pool.query<BroadcastRequestRow>(
      `SELECT b.tx_id, b.owner_address, b.contract_type, b.contract_address, b.function_selector,
              b.expiration_ms, b.state, b.energy_required, b.energy_deficit,
              b.bandwidth_required, b.bandwidth_deficit, b.error_code, b.error_message,
              b.created_at, b.updated_at,
              ${resourceAuditColumns}
         FROM broadcast_requests b
         LEFT JOIN transaction_resource_audits a ON a.tx_id = b.tx_id
        WHERE b.tx_id = $1`,
      [txId]
    );
    return result.rows[0] ? mapBroadcastRequest(result.rows[0]) : null;
  }

  async listRecentRequests(limit: number): Promise<BroadcastRequestSummary[]> {
    const result = await this.pool.query<BroadcastRequestRow>(
      `SELECT b.tx_id, b.owner_address, b.contract_type, b.contract_address, b.function_selector,
              b.expiration_ms, b.state, b.energy_required, b.energy_deficit,
              b.bandwidth_required, b.bandwidth_deficit, b.error_code, b.error_message,
              b.created_at, b.updated_at,
              ${resourceAuditColumns}
         FROM broadcast_requests b
         LEFT JOIN transaction_resource_audits a ON a.tx_id = b.tx_id
        ORDER BY b.created_at DESC, b.tx_id DESC
        LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapBroadcastRequest);
  }
}

function mapBinding(row: BindingRow): AddressBinding {
  return {
    address: row.address,
    label: row.label,
    enabled: row.enabled,
    maxTransactions: row.max_transactions === null ? null : BigInt(row.max_transactions),
    usedTransactions: BigInt(row.used_transactions),
    reservedTransactions: BigInt(row.reserved_transactions),
    expiresAt: row.expires_at
  };
}

function mapLease(row: LeaseRow): LeaseRecord {
  return {
    id: BigInt(row.id),
    txId: row.tx_id,
    resourceType: row.resource_type,
    resourceOwnerAddress: row.resource_owner_address,
    receiverAddress: row.receiver_address,
    balanceSun: BigInt(row.balance_sun),
    delegateTxId: row.delegate_tx_id,
    undelegateTxId: row.undelegate_tx_id,
    state: row.state,
    releaseAfter: row.release_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapBroadcastRequest(row: BroadcastRequestRow): BroadcastRequestSummary {
  return {
    txId: row.tx_id,
    ownerAddress: row.owner_address,
    contractType: row.contract_type,
    contractAddress: row.contract_address,
    functionSelector: row.function_selector,
    expirationMs: BigInt(row.expiration_ms),
    state: row.state,
    energyRequired: nullableBigInt(row.energy_required),
    energyDeficit: nullableBigInt(row.energy_deficit),
    bandwidthRequired: nullableBigInt(row.bandwidth_required),
    bandwidthDeficit: nullableBigInt(row.bandwidth_deficit),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    audit: mapResourceAudit(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapResourceAudit(row: ResourceAuditRow): ResourceAuditSummary | null {
  if (row.audit_tx_id == null) return null;
  if (row.audit_created_at === null || row.audit_updated_at === null) {
    throw new Error("Resource audit timestamps are missing");
  }
  return {
    energyEstimateRaw: nullableBigInt(row.audit_energy_estimate_raw),
    energyEstimateSafe: nullableBigInt(row.audit_energy_estimate_safe),
    estimateSafetyBps: row.audit_estimate_safety_bps,
    energyAvailableBefore: nullableBigInt(row.audit_energy_available_before),
    packageThreshold: nullableBigInt(row.audit_package_threshold),
    energyPackageQuoted: nullableBigInt(row.audit_energy_package_quoted),
    energyPackageAttempted: nullableBigInt(row.audit_energy_package_attempted),
    energyPriceSun: nullableBigInt(row.audit_energy_unit_price_sun),
    estimatedEnergyBurnSun: nullableBigInt(row.audit_estimated_energy_burn_sun),
    bandwidthBytes: nullableBigInt(row.audit_bandwidth_bytes),
    bandwidthStakedAvailable: nullableBigInt(row.audit_bandwidth_staked_available),
    bandwidthFreeAvailable: nullableBigInt(row.audit_bandwidth_free_available),
    bandwidthSource: row.audit_bandwidth_source,
    bandwidthUnitPriceSun: nullableBigInt(row.audit_bandwidth_unit_price_sun),
    estimatedBandwidthBurnSun: nullableBigInt(row.audit_estimated_bandwidth_burn_sun),
    ownerBalanceSun: nullableBigInt(row.audit_owner_balance_sun),
    feeLimitSun: nullableBigInt(row.audit_fee_limit_sun),
    minimumFeeLimitSun: nullableBigInt(row.audit_minimum_fee_limit_sun),
    maximumFeeLimitSun: nullableBigInt(row.audit_maximum_fee_limit_sun),
    energyAvailableAfter: nullableBigInt(row.audit_energy_available_after),
    energyArrivalDelta: nullableBigInt(row.audit_energy_arrival_delta),
    receiptEnergyUsageTotal: nullableBigInt(row.audit_receipt_energy_usage_total),
    receiptEnergyUsage: nullableBigInt(row.audit_receipt_energy_usage),
    receiptOriginEnergyUsage: nullableBigInt(row.audit_receipt_origin_energy_usage),
    receiptNetUsage: nullableBigInt(row.audit_receipt_net_usage),
    receiptNetFeeSun: nullableBigInt(row.audit_receipt_net_fee_sun),
    receiptEnergyFeeSun: nullableBigInt(row.audit_receipt_energy_fee_sun),
    receiptTotalFeeSun: nullableBigInt(row.audit_receipt_total_fee_sun),
    receiptResult: row.audit_receipt_result,
    plannedAt: row.audit_planned_at,
    energyArrivalObservedAt: row.audit_energy_arrival_observed_at,
    solidifiedAt: row.audit_solidified_at,
    createdAt: row.audit_created_at,
    updatedAt: row.audit_updated_at
  };
}

function nullableBigInt(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function assertBindingTransactionLimit(value: bigint | null | undefined): void {
  if (value !== null && value !== undefined && (value < 0n || value > 1_000_000n)) {
    throw new RangeError("maxTransactions must be between 0 and 1000000");
  }
}

function assertResourceAuditPlan(plan: ResourceAuditPlan): void {
  const nonnegative: ReadonlyArray<readonly [string, bigint]> = [
    ["energyEstimateRaw", plan.energyEstimateRaw],
    ["energyEstimateSafe", plan.energyEstimateSafe],
    ["energyAvailableBefore", plan.energyAvailableBefore],
    ["energyPriceSun", plan.energyPriceSun],
    ["estimatedEnergyBurnSun", plan.estimatedEnergyBurnSun],
    ["bandwidthBytes", plan.bandwidthBytes],
    ["bandwidthStakedAvailable", plan.bandwidthStakedAvailable],
    ["bandwidthFreeAvailable", plan.bandwidthFreeAvailable],
    ["bandwidthUnitPriceSun", plan.bandwidthUnitPriceSun],
    ["estimatedBandwidthBurnSun", plan.estimatedBandwidthBurnSun],
    ["ownerBalanceSun", plan.ownerBalanceSun],
    ["feeLimitSun", plan.feeLimitSun],
    ["minimumFeeLimitSun", plan.minimumFeeLimitSun],
    ["maximumFeeLimitSun", plan.maximumFeeLimitSun]
  ];
  for (const [name, value] of nonnegative) assertNonnegativeBigInt(value, name);
  if (plan.energyEstimateSafe < plan.energyEstimateRaw) {
    throw new RangeError("energyEstimateSafe cannot be smaller than energyEstimateRaw");
  }
  if (plan.packageThreshold <= 0n) throw new RangeError("packageThreshold must be positive");
  if (plan.maximumFeeLimitSun === 0n) {
    throw new RangeError("maximumFeeLimitSun must be positive");
  }
  if (plan.energyPackageQuoted !== null) {
    assertNonnegativeBigInt(plan.energyPackageQuoted, "energyPackageQuoted");
    if (plan.energyPackageQuoted === 0n) {
      throw new RangeError("energyPackageQuoted must be positive when present");
    }
  }
  if (
    !Number.isSafeInteger(plan.estimateSafetyBps) ||
    plan.estimateSafetyBps < 10_000 ||
    plan.estimateSafetyBps > 100_000
  ) {
    throw new RangeError("estimateSafetyBps must be an integer between 10000 and 100000");
  }
  if (!["STAKED", "FREE", "TRX"].includes(plan.bandwidthSource)) {
    throw new RangeError("bandwidthSource must be STAKED, FREE, or TRX");
  }
}

function assertNonnegativeBigInt(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError(`${name} must be a nonnegative bigint`);
  }
}

type SolidifiedReceiptAudit = {
  energyUsageTotal: bigint | null;
  energyUsage: bigint | null;
  originEnergyUsage: bigint | null;
  netUsage: bigint | null;
  netFeeSun: bigint | null;
  energyFeeSun: bigint | null;
  totalFeeSun: bigint | null;
  result: string;
};

export function summarizeSolidifiedReceipt(
  response: Record<string, unknown>,
  success: boolean
): SolidifiedReceiptAudit {
  const receipt = plainRecord(response.receipt);
  return {
    energyUsageTotal: protobufUnsigned(receipt, "energy_usage_total"),
    energyUsage: protobufUnsigned(receipt, "energy_usage"),
    originEnergyUsage: protobufUnsigned(receipt, "origin_energy_usage"),
    netUsage: protobufUnsigned(receipt, "net_usage"),
    netFeeSun: protobufUnsigned(receipt, "net_fee"),
    energyFeeSun: protobufUnsigned(receipt, "energy_fee"),
    totalFeeSun: protobufUnsigned(response, "fee"),
    result: normalizedReceiptResult(response.result ?? receipt?.result, success)
  };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function protobufUnsigned(record: Record<string, unknown> | null, key: string): bigint | null {
  if (!record) return null;
  if (!(key in record)) return 0n;
  const value = record[key];
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function normalizedReceiptResult(value: unknown, success: boolean): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return success ? "SUCCESS" : "FAILED";
  }
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_").slice(0, 64);
  return normalized || (success ? "SUCCESS" : "FAILED");
}

function databaseBigInt(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}
