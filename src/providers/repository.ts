import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ProviderSecretCipher } from "./crypto.js";
import { ProviderCredentialError, ProviderMustBeDisabledError } from "./types.js";
import type {
  EnergyProviderBudgetLimits,
  EnergyProviderBudgetProviderStatus,
  EnergyProviderBudgetStatus,
  EnergyProviderConfig,
  EnergyProviderCredential,
  EnergyProviderOrder,
  EnergyProviderOrderEvent,
  EnergyProviderOrderState,
  RentEnergyResult
} from "./types.js";
import {
  DEFAULT_GLOBAL_PROVIDER_BUDGET_LIMITS,
  DEFAULT_PROVIDER_BUDGET_LIMITS,
  MAX_ENERGY_ORDER_AMOUNT
} from "./types.js";

type ProviderRow = {
  id: string;
  provider_type: string;
  name: string;
  enabled: boolean;
  priority: number;
  rent_time: number;
  max_energy_per_order: string;
  daily_order_limit: string;
  daily_energy_limit: string;
  credential_id?: string;
  credential_version?: number;
  api_key_encrypted?: Buffer;
  api_key_configured: boolean;
  created_at: Date;
  updated_at: Date;
};

type AttemptSnapshotRow = ProviderRow & {
  order_state: string;
  order_requested_energy_amount: string;
  already_attempted: boolean;
  credential_id: string;
  credential_version: number;
  api_key_encrypted: Buffer;
  utc_day: string;
};

type CredentialRow = ProviderRow & {
  credential_id: string;
  credential_version: number;
  api_key_encrypted: Buffer;
};

type BudgetUsageRow = ProviderRow & {
  reserved_orders: string;
  reserved_energy: string;
  charged_orders: string;
  charged_energy: string;
  released_orders: string;
  released_energy: string;
};

type OrderRow = {
  id: string;
  tx_id: string;
  provider_id: string | null;
  receive_address: string;
  requested_energy_amount: string;
  energy_amount: string;
  rent_time: number | null;
  state: string;
  provider_order_id: string | null;
  provider_balance_trx: string | null;
  order_cost_trx: string | null;
  delegation_tx_hash: string | null;
  sender_addresses: string[] | null;
  failure_code: string | null;
  failure_message: string | null;
  attempts: unknown;
  created_at: Date;
  updated_at: Date;
};

export type CreateEnergyProviderInput = {
  type: string;
  name: string;
  apiKey: string;
  enabled?: boolean;
  priority?: number;
  rentTime: 1 | 15;
  maxEnergyPerOrder?: number;
  dailyOrderLimit?: number;
  dailyEnergyLimit?: number;
};

export type UpdateEnergyProviderInput = {
  name?: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  rentTime?: 1 | 15;
  maxEnergyPerOrder?: number;
  dailyOrderLimit?: number;
  dailyEnergyLimit?: number;
};

export type BeginEnergyOrderResult =
  | { kind: "created"; order: EnergyProviderOrder }
  | { kind: "existing"; order: EnergyProviderOrder };

const providerColumns = `id, provider_type, name, enabled, priority, rent_time,
  max_energy_per_order, daily_order_limit, daily_energy_limit,
  (octet_length(api_key_encrypted) > 0) AS api_key_configured, created_at, updated_at`;
const orderColumns = `id, tx_id, provider_id, receive_address, requested_energy_amount,
  energy_amount, rent_time, state,
  provider_order_id, provider_balance_trx, order_cost_trx, delegation_tx_hash,
  sender_addresses, failure_code, failure_message, attempts, created_at, updated_at`;
const BUDGET_LOCK_ID = "8073361072184432";
const KUAIZU_MAX_ENERGY_PER_ORDER = 131_000;

export class EnergyProviderRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly cipher: ProviderSecretCipher,
    private readonly budgetLimits: EnergyProviderBudgetLimits = DEFAULT_GLOBAL_PROVIDER_BUDGET_LIMITS
  ) {
    validateBudgetLimits(budgetLimits);
  }

  async listProviders(): Promise<EnergyProviderConfig[]> {
    const result = await this.pool.query<ProviderRow>(
      `SELECT ${providerColumns} FROM energy_providers ORDER BY priority ASC, id ASC`
    );
    return result.rows.map(mapProvider);
  }

  async getBudgetStatus(): Promise<EnergyProviderBudgetStatus> {
    const dayResult = await this.pool.query<{ utc_day: string }>(
      "SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text AS utc_day"
    );
    const utcDay = requiredRow(dayResult.rows[0], "Budget clock query returned no row").utc_day;
    const result = await this.pool.query<BudgetUsageRow>(
      `SELECT ${providerColumnsFor("p")},
              COUNT(l.id) FILTER (WHERE l.state = 'RESERVED')::bigint AS reserved_orders,
              COALESCE(SUM(l.energy_amount) FILTER (WHERE l.state = 'RESERVED'), 0)::bigint AS reserved_energy,
              COUNT(l.id) FILTER (WHERE l.state = 'CHARGED')::bigint AS charged_orders,
              COALESCE(SUM(l.energy_amount) FILTER (WHERE l.state = 'CHARGED'), 0)::bigint AS charged_energy,
              COUNT(l.id) FILTER (WHERE l.state = 'RELEASED')::bigint AS released_orders,
              COALESCE(SUM(l.energy_amount) FILTER (WHERE l.state = 'RELEASED'), 0)::bigint AS released_energy
         FROM energy_providers p
         LEFT JOIN energy_provider_budget_ledger l
           ON l.provider_id = p.id AND l.utc_day = $1::date
        GROUP BY p.id
        ORDER BY p.priority ASC, p.id ASC`,
      [utcDay]
    );
    const providers = result.rows.map(mapProviderBudgetStatus);
    const aggregate = providers.reduce(
      (total, provider) => ({
        reservedOrders: total.reservedOrders + provider.reservedOrders,
        reservedEnergy: total.reservedEnergy + provider.reservedEnergy,
        chargedOrders: total.chargedOrders + provider.chargedOrders,
        chargedEnergy: total.chargedEnergy + provider.chargedEnergy,
        releasedOrders: total.releasedOrders + provider.releasedOrders,
        releasedEnergy: total.releasedEnergy + provider.releasedEnergy
      }),
      emptyBudgetUsage()
    );
    const usedOrders = aggregate.reservedOrders + aggregate.chargedOrders;
    const usedEnergy = aggregate.reservedEnergy + aggregate.chargedEnergy;
    return {
      ...this.budgetLimits,
      window: "UTC_DAY",
      utcDay,
      ...aggregate,
      usedOrders,
      usedEnergy,
      remainingOrders: nonnegativeDifference(BigInt(this.budgetLimits.dailyOrderLimit), usedOrders),
      remainingEnergy: nonnegativeDifference(BigInt(this.budgetLimits.dailyEnergyLimit), usedEnergy),
      providers
    };
  }

  async getProvider(id: bigint): Promise<EnergyProviderConfig | null> {
    assertPositiveId(id);
    const result = await this.pool.query<ProviderRow>(
      `SELECT ${providerColumns} FROM energy_providers WHERE id = $1`,
      [id.toString()]
    );
    return result.rows[0] ? mapProvider(result.rows[0]) : null;
  }

  async getProviderCredential(id: bigint): Promise<EnergyProviderCredential | null> {
    assertPositiveId(id);
    const result = await this.pool.query<CredentialRow>(
      `SELECT ${providerColumns}, credential_id::text, credential_version, api_key_encrypted
         FROM energy_providers
        WHERE id = $1`,
      [id.toString()]
    );
    const row = result.rows[0];
    if (!row) return null;
    const provider = mapProvider(row);
    try {
      return {
        ...provider,
        apiKey: this.cipher.decrypt(row.api_key_encrypted, {
          providerType: row.provider_type,
          credentialId: row.credential_id,
          version: row.credential_version
        })
      };
    } catch {
      throw new ProviderCredentialError(provider);
    }
  }

  async createProvider(input: CreateEnergyProviderInput): Promise<EnergyProviderConfig> {
    const normalized = validateProviderInput(input);
    const limits = providerLimits(input, normalized.type);
    const credentialId = randomUUID();
    const encrypted = this.cipher.encrypt(input.apiKey, {
      providerType: normalized.type,
      credentialId,
      version: 1
    });
    const result = await this.pool.query<ProviderRow>(
      `INSERT INTO energy_providers(
         provider_type, name, enabled, priority, rent_time,
         max_energy_per_order, daily_order_limit, daily_energy_limit,
         credential_id, credential_version, api_key_encrypted
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10)
       RETURNING ${providerColumns}`,
      [
        normalized.type,
        normalized.name,
        input.enabled ?? false,
        input.priority ?? 100,
        input.rentTime,
        limits.maxEnergyPerOrder,
        limits.dailyOrderLimit,
        limits.dailyEnergyLimit,
        credentialId,
        encrypted
      ]
    );
    return mapProvider(requiredRow(result.rows[0], "Provider insert returned no row"));
  }

  async updateProvider(
    id: bigint,
    input: UpdateEnergyProviderInput
  ): Promise<EnergyProviderConfig | null> {
    assertPositiveId(id);
    validateProviderPatch(input);
    const normalizedName = input.name === undefined ? null : validateName(input.name);
    const existing = await this.pool.query<{
      provider_type: string;
      credential_id: string;
      credential_version: number;
      max_energy_per_order: string;
      daily_order_limit: string;
      daily_energy_limit: string;
    }>(
      `SELECT provider_type, credential_id::text, credential_version,
              max_energy_per_order, daily_order_limit, daily_energy_limit
         FROM energy_providers WHERE id = $1`,
      [id.toString()]
    );
    const current = existing.rows[0];
    if (!current) return null;
    const effectiveMaxEnergyPerOrder = input.maxEnergyPerOrder ?? Number(current.max_energy_per_order);
    validateProviderMaximum(current.provider_type, effectiveMaxEnergyPerOrder);
    validateBudgetLimits({
      maxEnergyPerOrder: effectiveMaxEnergyPerOrder,
      dailyOrderLimit: input.dailyOrderLimit ?? Number(current.daily_order_limit),
      dailyEnergyLimit: input.dailyEnergyLimit ?? Number(current.daily_energy_limit)
    });
    const replaceApiKey = input.apiKey !== undefined;
    const changesPaidExecutionSettings =
      replaceApiKey ||
      input.rentTime !== undefined ||
      input.maxEnergyPerOrder !== undefined ||
      input.dailyOrderLimit !== undefined ||
      input.dailyEnergyLimit !== undefined;
    const nextCredentialVersion = current.credential_version + 1;
    const encrypted = replaceApiKey
      ? this.cipher.encrypt(input.apiKey!, {
          providerType: current.provider_type,
          credentialId: current.credential_id,
          version: nextCredentialVersion
        })
      : null;
    const result = await this.pool.query<ProviderRow>(
      `UPDATE energy_providers SET
         name = CASE WHEN $2::boolean THEN $3 ELSE name END,
         enabled = CASE WHEN $4::boolean THEN $5 ELSE enabled END,
         priority = CASE WHEN $6::boolean THEN $7 ELSE priority END,
         rent_time = CASE WHEN $8::boolean THEN $9 ELSE rent_time END,
         max_energy_per_order = CASE WHEN $10::boolean THEN $11 ELSE max_energy_per_order END,
         daily_order_limit = CASE WHEN $12::boolean THEN $13 ELSE daily_order_limit END,
         daily_energy_limit = CASE WHEN $14::boolean THEN $15 ELSE daily_energy_limit END,
         api_key_encrypted = CASE WHEN $16::boolean THEN $17 ELSE api_key_encrypted END,
         credential_version = CASE WHEN $16::boolean THEN $19 ELSE credential_version END,
         updated_at = NOW()
       WHERE id = $1
         AND (NOT $16::boolean OR credential_version = $18)
         AND (NOT $20::boolean OR enabled = FALSE)
       RETURNING ${providerColumns}`,
      [
        id.toString(),
        input.name !== undefined,
        normalizedName,
        input.enabled !== undefined,
        input.enabled ?? null,
        input.priority !== undefined,
        input.priority ?? null,
        input.rentTime !== undefined,
        input.rentTime ?? null,
        input.maxEnergyPerOrder !== undefined,
        input.maxEnergyPerOrder ?? null,
        input.dailyOrderLimit !== undefined,
        input.dailyOrderLimit ?? null,
        input.dailyEnergyLimit !== undefined,
        input.dailyEnergyLimit ?? null,
        replaceApiKey,
        encrypted,
        current.credential_version,
        nextCredentialVersion,
        changesPaidExecutionSettings
      ]
    );
    if (!result.rows[0] && changesPaidExecutionSettings) {
      const latest = await this.getProvider(id);
      if (latest?.enabled) throw new ProviderMustBeDisabledError();
    }
    if (!result.rows[0] && replaceApiKey) {
      throw new Error("Provider credential was changed concurrently; reload before saving again");
    }
    return result.rows[0] ? mapProvider(result.rows[0]) : null;
  }

  async disableProvider(id: bigint): Promise<boolean> {
    assertPositiveId(id);
    const result = await this.pool.query(
      "UPDATE energy_providers SET enabled = FALSE, updated_at = NOW() WHERE id = $1",
      [id.toString()]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listEnabledProviders(): Promise<EnergyProviderConfig[]> {
    const result = await this.pool.query<ProviderRow>(
      `SELECT ${providerColumns}
         FROM energy_providers
        WHERE enabled
        ORDER BY priority ASC, id ASC
        LIMIT 100`
    );
    return result.rows.map(mapProvider);
  }

  async beginOrder(input: {
    txId: string;
    receiveAddress: string;
    amount: number;
  }): Promise<BeginEnergyOrderResult> {
    const inserted = await this.pool.query<OrderRow>(
      `INSERT INTO energy_provider_orders(
         tx_id, receive_address, requested_energy_amount, energy_amount, state, attempts
       ) VALUES ($1, $2, $3, $3, 'PENDING', '[]'::jsonb)
       ON CONFLICT (tx_id) DO NOTHING
       RETURNING ${orderColumns}`,
      [input.txId, input.receiveAddress, input.amount]
    );
    if (inserted.rows[0]) return { kind: "created", order: mapOrder(inserted.rows[0]) };
    const existing = await this.pool.query<OrderRow>(
      `SELECT ${orderColumns} FROM energy_provider_orders WHERE tx_id = $1`,
      [input.txId]
    );
    return {
      kind: "existing",
      order: mapOrder(requiredRow(existing.rows[0], "Existing provider order was not found"))
    };
  }

  async startAttempt(
    orderId: bigint,
    providerId: bigint,
    energyAmount: number
  ): Promise<{ order: EnergyProviderOrder; provider: EnergyProviderCredential } | null> {
    assertPositiveId(orderId);
    assertPositiveId(providerId);
    validateEnergyAmount(energyAmount);
    const client = await this.pool.connect();
    let snapshot: AttemptSnapshotRow | undefined;
    let order: EnergyProviderOrder | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      // A process-wide lock is deliberately separate from all reads. Under READ COMMITTED,
      // the next statement receives a fresh snapshot after the previous holder commits.
      await client.query(`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_ID}::bigint)`);
      const snapshotResult = await client.query<AttemptSnapshotRow>(
        `SELECT ${providerColumnsFor("p")},
                p.credential_id::text AS credential_id,
                p.credential_version,
                p.api_key_encrypted,
                o.state AS order_state,
                o.requested_energy_amount AS order_requested_energy_amount,
                (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS utc_day,
                EXISTS (
                  SELECT 1 FROM jsonb_array_elements(o.attempts) AS event
                   WHERE event->>'state' = 'ORDERING' AND event->>'providerId' = p.id::text
                ) AS already_attempted
           FROM energy_provider_orders o
           JOIN energy_providers p ON p.id = $2
          WHERE o.id = $1
          FOR UPDATE OF o, p`,
        [orderId.toString(), providerId.toString()]
      );
      snapshot = snapshotResult.rows[0];
      if (
        !snapshot ||
        !snapshot.enabled ||
        !["PENDING", "REJECTED"].includes(snapshot.order_state) ||
        snapshot.already_attempted
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const providerEnergyAmount = BigInt(energyAmount);
      const globalMax = BigInt(this.budgetLimits.maxEnergyPerOrder);
      const providerMax = BigInt(snapshot.max_energy_per_order);
      if (providerEnergyAmount > globalMax || providerEnergyAmount > providerMax) {
        await client.query("ROLLBACK");
        return null;
      }

      const usageResult = await client.query<{
        global_orders: string;
        global_energy: string;
        provider_orders: string;
        provider_energy: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE state IN ('RESERVED', 'CHARGED'))::bigint AS global_orders,
           COALESCE(SUM(energy_amount) FILTER (WHERE state IN ('RESERVED', 'CHARGED')), 0)::bigint AS global_energy,
           COUNT(*) FILTER (
             WHERE provider_id = $2 AND state IN ('RESERVED', 'CHARGED')
           )::bigint AS provider_orders,
           COALESCE(SUM(energy_amount) FILTER (
             WHERE provider_id = $2 AND state IN ('RESERVED', 'CHARGED')
           ), 0)::bigint AS provider_energy
         FROM energy_provider_budget_ledger
        WHERE utc_day = $1::date`,
        [snapshot.utc_day, providerId.toString()]
      );
      const usage = requiredRow(usageResult.rows[0], "Budget usage query returned no row");
      if (
        BigInt(usage.global_orders) + 1n > BigInt(this.budgetLimits.dailyOrderLimit) ||
        BigInt(usage.global_energy) + providerEnergyAmount > BigInt(this.budgetLimits.dailyEnergyLimit) ||
        BigInt(usage.provider_orders) + 1n > BigInt(snapshot.daily_order_limit) ||
        BigInt(usage.provider_energy) + providerEnergyAmount > BigInt(snapshot.daily_energy_limit)
      ) {
        await client.query("ROLLBACK");
        return null;
      }

      const reservation = await client.query(
        `INSERT INTO energy_provider_budget_ledger(
           utc_day, order_id, provider_id, energy_amount, state
         ) VALUES ($1::date, $2, $3, $4, 'RESERVED')
         ON CONFLICT (order_id, provider_id) DO NOTHING
         RETURNING id`,
        [
          snapshot.utc_day,
          orderId.toString(),
          providerId.toString(),
          providerEnergyAmount.toString()
        ]
      );
      if (!reservation.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const orderResult = await client.query<OrderRow>(
        `UPDATE energy_provider_orders SET
           provider_id = $2::bigint,
           rent_time = $3,
           energy_amount = $5::bigint,
           state = 'ORDERING',
           failure_code = NULL,
           failure_message = NULL,
           attempts = attempts || jsonb_build_array(jsonb_build_object(
             'state', 'ORDERING', 'providerId', ($2::bigint)::text, 'providerType', $4::text,
             'requestedEnergyAmount', requested_energy_amount::text,
             'energyAmount', $5::text, 'code', NULL, 'at', NOW()
           )),
           updated_at = NOW()
         WHERE id = $1 AND state IN ('PENDING', 'REJECTED')
         RETURNING ${orderColumns}`,
        [
          orderId.toString(),
          providerId.toString(),
          snapshot.rent_time,
          snapshot.provider_type,
          providerEnergyAmount.toString()
        ]
      );
      order = mapOrder(requiredRow(orderResult.rows[0], "Provider order could not enter ORDERING"));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!snapshot || !order) return null;
    const provider = mapProvider(snapshot);
    try {
      return {
        order,
        provider: {
          ...provider,
          apiKey: this.cipher.decrypt(snapshot.api_key_encrypted, {
            providerType: snapshot.provider_type,
            credentialId: snapshot.credential_id,
            version: snapshot.credential_version
          })
        }
      };
    } catch {
      throw new ProviderCredentialError(provider);
    }
  }

  async markRejected(
    orderId: bigint,
    provider: EnergyProviderConfig,
    code: string
  ): Promise<EnergyProviderOrder> {
    return this.finishAttempt(orderId, provider, "REJECTED", code);
  }

  async markUnknown(
    orderId: bigint,
    provider: EnergyProviderConfig,
    code: string
  ): Promise<EnergyProviderOrder> {
    return this.finishAttempt(
      orderId,
      provider,
      "UNKNOWN",
      code
    );
  }

  async rejectWithoutProvider(orderId: bigint, code: string): Promise<EnergyProviderOrder> {
    const safeCode = safeProviderCode(code);
    const result = await this.pool.query<OrderRow>(
      `UPDATE energy_provider_orders SET
         state = 'REJECTED', failure_code = $2,
         failure_message = CASE WHEN $2::text = 'NO_ENABLED_PROVIDER'
           THEN 'No enabled energy provider is available'
           WHEN $2::text = 'NO_ELIGIBLE_PROVIDER_PACKAGE'
           THEN 'No enabled energy provider supports the requested package amount'
           ELSE 'No eligible energy provider capacity is available' END,
         attempts = attempts || jsonb_build_array(jsonb_build_object(
           'state', 'REJECTED', 'providerId', NULL, 'providerType', NULL,
           'code', $2::text, 'at', NOW()
         )),
         updated_at = NOW()
       WHERE id = $1 AND state = 'PENDING'
       RETURNING ${orderColumns}`,
      [orderId.toString(), safeCode]
    );
    return mapOrder(requiredRow(result.rows[0], "Provider order could not be rejected"));
  }

  async markAccepted(
    orderId: bigint,
    provider: EnergyProviderCredential,
    outcome: Extract<RentEnergyResult, { kind: "accepted" }>
  ): Promise<EnergyProviderOrder> {
    return this.transitionAttempt(
      orderId,
      provider.id,
      "CHARGED",
      (client) => client.query<OrderRow>(
        `UPDATE energy_provider_orders SET
           state = 'ACCEPTED', provider_order_id = $3, provider_balance_trx = $4,
           order_cost_trx = $5, delegation_tx_hash = $6, sender_addresses = $7,
           failure_code = NULL, failure_message = NULL,
           attempts = attempts || jsonb_build_array(jsonb_build_object(
             'state', 'ACCEPTED', 'providerId', ($2::bigint)::text, 'providerType', $8::text,
             'code', NULL, 'at', NOW()
           )),
           updated_at = NOW()
         WHERE id = $1 AND provider_id = $2::bigint AND state = 'ORDERING'
         RETURNING ${orderColumns}`,
        [
          orderId.toString(),
          provider.id.toString(),
          outcome.providerOrderId,
          outcome.providerBalanceTrx,
          outcome.orderCostTrx,
          outcome.delegationTxHash,
          [...outcome.senderAddresses],
          provider.type
        ]
      )
    );
  }

  async markFulfilled(txId: string): Promise<EnergyProviderOrder> {
    return this.finishConfirmation(txId, "FULFILLED", null);
  }

  async markConfirmationTimeout(txId: string): Promise<EnergyProviderOrder> {
    return this.finishConfirmation(txId, "UNKNOWN", "CONFIRMATION_TIMEOUT");
  }

  async recoverInterruptedOrders(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_ID}::bigint)`);
      await client.query(
        `UPDATE energy_provider_budget_ledger l SET state = 'CHARGED', updated_at = NOW()
          FROM energy_provider_orders o
         WHERE l.order_id = o.id AND l.provider_id = o.provider_id
           AND l.state = 'RESERVED' AND o.state = 'ORDERING'`
      );
      const result = await client.query(
        `UPDATE energy_provider_orders SET
           state = 'UNKNOWN', failure_code = 'PROCESS_INTERRUPTED',
           failure_message = 'Ordering was interrupted; manual review is required',
           attempts = attempts || jsonb_build_array(jsonb_build_object(
             'state', 'UNKNOWN', 'providerId', provider_id::text, 'providerType', NULL,
             'code', 'PROCESS_INTERRUPTED', 'at', NOW()
           )),
           updated_at = NOW()
         WHERE state = 'ORDERING'`
      );
      await client.query("COMMIT");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getOrderByTxId(txId: string): Promise<EnergyProviderOrder | null> {
    const result = await this.pool.query<OrderRow>(
      `SELECT ${orderColumns} FROM energy_provider_orders WHERE tx_id = $1`,
      [txId]
    );
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  async listRecentOrders(limit = 100): Promise<EnergyProviderOrder[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError("Order list limit must be between 1 and 200");
    }
    const result = await this.pool.query<OrderRow>(
      `SELECT ${orderColumns}
         FROM energy_provider_orders
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapOrder);
  }

  private async finishAttempt(
    orderId: bigint,
    provider: EnergyProviderConfig,
    state: "REJECTED" | "UNKNOWN",
    code: string
  ): Promise<EnergyProviderOrder> {
    const safeCode = safeProviderCode(code);
    const safeMessage = state === "REJECTED"
      ? "Provider explicitly rejected the order"
      : "Provider request outcome is unknown; manual review is required";
    return this.transitionAttempt(
      orderId,
      provider.id,
      state === "REJECTED" ? "RELEASED" : "CHARGED",
      (client) => client.query<OrderRow>(
        `UPDATE energy_provider_orders SET
           state = $3, failure_code = $4, failure_message = $5,
           attempts = attempts || jsonb_build_array(jsonb_build_object(
             'state', $3::text, 'providerId', ($2::bigint)::text, 'providerType', $6::text,
             'code', $4::text, 'at', NOW()
           )),
           updated_at = NOW()
         WHERE id = $1 AND provider_id = $2::bigint AND state = 'ORDERING'
         RETURNING ${orderColumns}`,
        [orderId.toString(), provider.id.toString(), state, safeCode, safeMessage, provider.type]
      )
    );
  }

  private async transitionAttempt(
    orderId: bigint,
    providerId: bigint,
    ledgerState: "CHARGED" | "RELEASED",
    updateOrder: (client: pg.PoolClient) => Promise<pg.QueryResult<OrderRow>>
  ): Promise<EnergyProviderOrder> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_ID}::bigint)`);
      const orderResult = await updateOrder(client);
      const row = requiredRow(orderResult.rows[0], "Provider order state transition was rejected");
      const ledgerResult = await client.query(
        `UPDATE energy_provider_budget_ledger SET state = $3, updated_at = NOW()
          WHERE order_id = $1 AND provider_id = $2 AND state = 'RESERVED'`,
        [orderId.toString(), providerId.toString(), ledgerState]
      );
      if ((ledgerResult.rowCount ?? 0) !== 1) {
        throw new Error("Provider budget reservation state transition was rejected");
      }
      await client.query("COMMIT");
      return mapOrder(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async finishConfirmation(
    txId: string,
    state: "FULFILLED" | "UNKNOWN",
    code: "CONFIRMATION_TIMEOUT" | null
  ): Promise<EnergyProviderOrder> {
    const result = await this.pool.query<OrderRow>(
      `UPDATE energy_provider_orders SET
         state = $2,
         failure_code = $3,
         failure_message = CASE WHEN $3::text IS NULL THEN NULL
           ELSE 'Provider accepted the order but energy delivery was not confirmed' END,
         attempts = attempts || jsonb_build_array(jsonb_build_object(
           'state', $2::text, 'providerId', provider_id::text, 'providerType', NULL,
           'code', $3::text, 'at', NOW()
         )),
         updated_at = NOW()
       WHERE tx_id = $1 AND state = 'ACCEPTED'
       RETURNING ${orderColumns}`,
      [txId, state, code]
    );
    if (result.rows[0]) return mapOrder(result.rows[0]);
    const existing = await this.getOrderByTxId(txId);
    if (existing?.state === state) return existing;
    throw new Error(`Provider order could not enter ${state}`);
  }
}

function mapProvider(row: ProviderRow): EnergyProviderConfig {
  if (row.rent_time !== 1 && row.rent_time !== 15) throw new Error("Invalid provider rent time in database");
  return {
    id: BigInt(row.id),
    type: row.provider_type,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    rentTime: row.rent_time,
    maxEnergyPerOrder: safeDatabaseNumber(row.max_energy_per_order, "max_energy_per_order"),
    dailyOrderLimit: safeDatabaseNumber(row.daily_order_limit, "daily_order_limit"),
    dailyEnergyLimit: safeDatabaseNumber(row.daily_energy_limit, "daily_energy_limit"),
    apiKeyConfigured: row.api_key_configured,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProviderBudgetStatus(row: BudgetUsageRow): EnergyProviderBudgetProviderStatus {
  const provider = mapProvider(row);
  const reservedOrders = BigInt(row.reserved_orders);
  const reservedEnergy = BigInt(row.reserved_energy);
  const chargedOrders = BigInt(row.charged_orders);
  const chargedEnergy = BigInt(row.charged_energy);
  const releasedOrders = BigInt(row.released_orders);
  const releasedEnergy = BigInt(row.released_energy);
  const usedOrders = reservedOrders + chargedOrders;
  const usedEnergy = reservedEnergy + chargedEnergy;
  return {
    providerId: provider.id,
    type: provider.type,
    name: provider.name,
    enabled: provider.enabled,
    maxEnergyPerOrder: provider.maxEnergyPerOrder,
    dailyOrderLimit: provider.dailyOrderLimit,
    dailyEnergyLimit: provider.dailyEnergyLimit,
    reservedOrders,
    reservedEnergy,
    chargedOrders,
    chargedEnergy,
    releasedOrders,
    releasedEnergy,
    usedOrders,
    usedEnergy,
    remainingOrders: nonnegativeDifference(BigInt(provider.dailyOrderLimit), usedOrders),
    remainingEnergy: nonnegativeDifference(BigInt(provider.dailyEnergyLimit), usedEnergy)
  };
}

function mapOrder(row: OrderRow): EnergyProviderOrder {
  const requestedAmount = Number(row.requested_energy_amount);
  const amount = Number(row.energy_amount);
  if (!Number.isSafeInteger(requestedAmount)) {
    throw new Error("Invalid requested provider energy amount in database");
  }
  if (!Number.isSafeInteger(amount)) throw new Error("Invalid provider order amount in database");
  if (row.rent_time !== null && row.rent_time !== 1 && row.rent_time !== 15) {
    throw new Error("Invalid provider order rent time in database");
  }
  return {
    id: BigInt(row.id),
    txId: row.tx_id.trim(),
    providerId: row.provider_id === null ? null : BigInt(row.provider_id),
    receiveAddress: row.receive_address,
    requestedAmount,
    amount,
    rentTime: row.rent_time,
    state: assertOrderState(row.state),
    providerOrderId: row.provider_order_id,
    providerBalanceTrx: row.provider_balance_trx,
    orderCostTrx: row.order_cost_trx,
    delegationTxHash: row.delegation_tx_hash?.trim() ?? null,
    senderAddresses: row.sender_addresses ?? [],
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    attempts: parseEvents(row.attempts),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateProviderInput(input: CreateEnergyProviderInput): { type: string; name: string } {
  assertProviderType(input.type);
  const name = validateName(input.name);
  validatePriority(input.priority ?? 100);
  validateRentTime(input.rentTime);
  providerLimits(input, input.type);
  return { type: input.type, name };
}

function validateProviderPatch(input: UpdateEnergyProviderInput): void {
  if (Object.keys(input).length === 0) throw new Error("At least one provider field must be supplied");
  if (input.name !== undefined) validateName(input.name);
  if (input.priority !== undefined) validatePriority(input.priority);
  if (input.rentTime !== undefined) validateRentTime(input.rentTime);
  for (const value of [input.maxEnergyPerOrder, input.dailyOrderLimit, input.dailyEnergyLimit]) {
    if (value !== undefined && !Number.isSafeInteger(value)) {
      throw new RangeError("Provider budget limits must be safe integers");
    }
  }
  if (
    input.maxEnergyPerOrder !== undefined &&
    input.dailyEnergyLimit !== undefined
  ) {
    validateBudgetLimits({
      maxEnergyPerOrder: input.maxEnergyPerOrder,
      dailyOrderLimit: input.dailyOrderLimit ?? DEFAULT_PROVIDER_BUDGET_LIMITS.dailyOrderLimit,
      dailyEnergyLimit: input.dailyEnergyLimit
    });
  }
}

function validateName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 100) throw new Error("Provider name must contain 1 to 100 characters");
  return normalized;
}

function assertProviderType(type: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(type)) throw new Error("Invalid energy provider type");
}

function validatePriority(priority: number): void {
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1_000_000) {
    throw new RangeError("Provider priority must be between 0 and 1000000");
  }
}

function validateRentTime(rentTime: number): asserts rentTime is 1 | 15 {
  if (rentTime !== 1 && rentTime !== 15) throw new RangeError("Provider rentTime must be 1 or 15");
}

function assertPositiveId(id: bigint): void {
  if (id < 1n) throw new RangeError("Provider id must be positive");
}

function validateEnergyAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ENERGY_ORDER_AMOUNT) {
    throw new RangeError(`Energy amount must be between 1 and ${MAX_ENERGY_ORDER_AMOUNT}`);
  }
}

function assertOrderState(state: string): EnergyProviderOrderState {
  if (!["PENDING", "ORDERING", "ACCEPTED", "FULFILLED", "REJECTED", "UNKNOWN"].includes(state)) {
    throw new Error("Invalid provider order state in database");
  }
  return state as EnergyProviderOrderState;
}

function parseEvents(value: unknown): readonly EnergyProviderOrderEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): EnergyProviderOrderEvent[] => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    try {
      return [{
        state: assertOrderState(String(candidate.state)),
        providerId: candidate.providerId === null || candidate.providerId === undefined
          ? null
          : String(candidate.providerId),
        providerType: candidate.providerType === null || candidate.providerType === undefined
          ? null
          : String(candidate.providerType),
        requestedAmount: optionalEnergyAmount(candidate.requestedEnergyAmount),
        orderedAmount: optionalEnergyAmount(candidate.energyAmount),
        code: candidate.code === null || candidate.code === undefined ? null : String(candidate.code),
        at: String(candidate.at)
      }];
    } catch {
      return [];
    }
  });
}

function optionalEnergyAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  validateEnergyAmount(parsed);
  return parsed;
}

function safeProviderCode(value: string): string {
  return /^[A-Z0-9_-]{1,100}$/.test(value) ? value : "PROVIDER_ERROR";
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

function validateBudgetLimits(limits: EnergyProviderBudgetLimits): void {
  const entries = [
    ["maxEnergyPerOrder", limits.maxEnergyPerOrder, MAX_ENERGY_ORDER_AMOUNT],
    ["dailyOrderLimit", limits.dailyOrderLimit, 1_000_000],
    ["dailyEnergyLimit", limits.dailyEnergyLimit, 1_000_000_000_000]
  ] as const;
  for (const [name, value, maximum] of entries) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
    }
  }
  if (limits.dailyEnergyLimit < limits.maxEnergyPerOrder) {
    throw new RangeError("dailyEnergyLimit must be at least maxEnergyPerOrder");
  }
}

function providerLimits(input: {
  maxEnergyPerOrder?: number;
  dailyOrderLimit?: number;
  dailyEnergyLimit?: number;
}, providerType?: string): EnergyProviderBudgetLimits {
  const limits = {
    maxEnergyPerOrder: input.maxEnergyPerOrder ?? (
      providerType === "kuaizu"
        ? KUAIZU_MAX_ENERGY_PER_ORDER
        : DEFAULT_PROVIDER_BUDGET_LIMITS.maxEnergyPerOrder
    ),
    dailyOrderLimit: input.dailyOrderLimit ?? DEFAULT_PROVIDER_BUDGET_LIMITS.dailyOrderLimit,
    dailyEnergyLimit: input.dailyEnergyLimit ?? DEFAULT_PROVIDER_BUDGET_LIMITS.dailyEnergyLimit
  };
  validateBudgetLimits(limits);
  if (providerType !== undefined) validateProviderMaximum(providerType, limits.maxEnergyPerOrder);
  return limits;
}

function validateProviderMaximum(providerType: string, maxEnergyPerOrder: number): void {
  if (providerType === "kuaizu" && maxEnergyPerOrder > KUAIZU_MAX_ENERGY_PER_ORDER) {
    throw new RangeError("Kuaizu maxEnergyPerOrder cannot exceed the 131000 ENERGY package");
  }
}

function safeDatabaseNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${field} in database`);
  return parsed;
}

function providerColumnsFor(alias: string): string {
  return `${alias}.id AS id, ${alias}.provider_type, ${alias}.name, ${alias}.enabled,
    ${alias}.priority, ${alias}.rent_time, ${alias}.max_energy_per_order,
    ${alias}.daily_order_limit, ${alias}.daily_energy_limit,
    (octet_length(${alias}.api_key_encrypted) > 0) AS api_key_configured,
    ${alias}.created_at, ${alias}.updated_at`;
}

function emptyBudgetUsage() {
  return {
    reservedOrders: 0n,
    reservedEnergy: 0n,
    chargedOrders: 0n,
    chargedEnergy: 0n,
    releasedOrders: 0n,
    releasedEnergy: 0n
  };
}

function nonnegativeDifference(limit: bigint, used: bigint): bigint {
  return limit > used ? limit - used : 0n;
}
