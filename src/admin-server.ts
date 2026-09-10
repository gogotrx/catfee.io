import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { z } from "zod";
import { logger } from "./logger.js";
import { TronNodeApi } from "./node-api.js";
import { KUAIZU_PROVIDER_TYPE } from "./providers/kuaizu.js";
import type { EnergyProviderRepository } from "./providers/repository.js";
import type { EnergyProviderService } from "./providers/service.js";
import type { EnergyProviderOrder } from "./providers/types.js";
import {
  ProviderAccountQueryError,
  ProviderAccountQueryUnsupportedError,
  ProviderCredentialError,
  ProviderMustBeDisabledError
} from "./providers/types.js";
import { GatewayRepository } from "./repository.js";
import { SignerClient } from "./signer-client.js";
import { normalizeTronAddress } from "./tron-address.js";

const MAX_BINDING_TRANSACTIONS = 1_000_000n;
const transactionLimitInput = z.union([
  z
    .string()
    .regex(/^(?:0|[1-9]\d{0,6})$/)
    .refine((value) => BigInt(value) <= MAX_BINDING_TRANSACTIONS, "maximum is 1000000"),
  z.number().int().min(0).max(Number(MAX_BINDING_TRANSACTIONS)),
  z.null()
]);

const bindingInput = z.object({
  address: z.string().min(1),
  label: z.string().max(200).nullable().optional(),
  maxTransactions: transactionLimitInput.optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  enabled: z.boolean().optional()
}).strict();

const enabledInput = z.object({ enabled: z.boolean() }).strict();
const resetInput = z.object({
  maxTransactions: transactionLimitInput.optional()
}).strict();
const providerApiKeyInput = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, "API key must not contain edge whitespace");
const providerMaxEnergyInput = z.number().int().min(1).max(10_000_000);
const providerDailyOrdersInput = z.number().int().min(1).max(1_000_000);
const providerDailyEnergyInput = z.number().int().min(1).max(1_000_000_000_000);
const providerCreateInput = z.object({
  type: z.literal(KUAIZU_PROVIDER_TYPE),
  name: z.string().trim().min(1).max(100),
  apiKey: providerApiKeyInput,
  enabled: z.literal(false).optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  rentTime: z.union([z.literal(1), z.literal(15)]),
  maxEnergyPerOrder: providerMaxEnergyInput.optional(),
  dailyOrderLimit: providerDailyOrdersInput.optional(),
  dailyEnergyLimit: providerDailyEnergyInput.optional()
}).strict().refine(
  (value) =>
    value.maxEnergyPerOrder === undefined ||
    value.dailyEnergyLimit === undefined ||
    value.dailyEnergyLimit >= value.maxEnergyPerOrder,
  "dailyEnergyLimit must be at least maxEnergyPerOrder"
);
const providerUpdateInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  apiKey: providerApiKeyInput.optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  rentTime: z.union([z.literal(1), z.literal(15)]).optional(),
  maxEnergyPerOrder: providerMaxEnergyInput.optional(),
  dailyOrderLimit: providerDailyOrdersInput.optional(),
  dailyEnergyLimit: providerDailyEnergyInput.optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export type AdminRuntimeConfig = {
  mode: "passthrough" | "observe" | "sponsor";
  gatewayPort: number;
  authMode: "none" | "bound_address";
  unsupportedPolicy: "forward" | "reject";
  insufficientPolicy: "forward" | "reject";
  sponsorEnergy: boolean;
  sponsorBandwidth: boolean;
  energySource: "self" | "provider";
  allowOwnerBandwidthBurn: boolean;
  maxOwnerBandwidthBurnSun: bigint;
  allowOwnerEnergyBurn: boolean;
  maxOwnerEnergyBurnSun: bigint;
  energyPackageThreshold: number;
  providerMaxEnergyPerOrder: number;
  providerDailyMaxOrders: number;
  providerDailyMaxEnergy: number;
  resourceOwnerAddress?: string;
};

export class AdminServer {
  private readonly server: http.Server;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly token: string,
    private readonly repository: GatewayRepository,
    private readonly node: TronNodeApi,
    private readonly runtime: AdminRuntimeConfig,
    private readonly signer: Pick<SignerClient, "health">,
    private readonly energyProviderRepository?: EnergyProviderRepository,
    private readonly webRoot = path.resolve(process.cwd(), "web"),
    private readonly energyProviderService?: Pick<EnergyProviderService, "queryAccountSnapshot">
  ) {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const normalized = normalizeAdminError(error);
        const clientError = normalized.status < 500;
        if (clientError) logger.warn({ err: error }, "admin API rejected invalid input");
        else logger.error({ err: error }, "admin API request failed");
        sendJson(response, normalized.status, { error: normalized.code });
      });
    });
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxRequestsPerSocket = 100;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    logger.info({ host: this.host, port: this.port }, "admin API listening");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  address(): AddressInfo | string | null {
    return this.server.address();
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const asset = WEB_ASSETS.get(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && asset) {
      await sendWebAsset(response, request.method === "HEAD", this.webRoot, asset);
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (!authorized(request.headers.authorization, this.token)) {
      response.setHeader("www-authenticate", "Bearer");
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      try {
        await Promise.all([this.repository.ping(), this.node.getNodeInfo()]);
      } catch (error) {
        throw new AdminInputError("A readiness dependency is unavailable", 503, "not_ready", { cause: error });
      }
      sendJson(response, 200, { status: "ready" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/status") {
      sendJson(response, 200, await this.status());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/bindings") {
      sendJson(response, 200, { bindings: await this.repository.listBindings() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/providers") {
      const providers = this.requireEnergyProviderRepository();
      sendJson(response, 200, { providers: await providers.listProviders() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/providers") {
      const providers = this.requireEnergyProviderRepository();
      const input = providerCreateInput.parse(await readJson(request));
      const provider = await providers.createProvider({
        type: input.type,
        name: input.name,
        apiKey: input.apiKey,
        rentTime: input.rentTime,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.maxEnergyPerOrder !== undefined ? { maxEnergyPerOrder: input.maxEnergyPerOrder } : {}),
        ...(input.dailyOrderLimit !== undefined ? { dailyOrderLimit: input.dailyOrderLimit } : {}),
        ...(input.dailyEnergyLimit !== undefined ? { dailyEnergyLimit: input.dailyEnergyLimit } : {})
      });
      logger.info(
        { action: "provider.create", providerId: provider.id.toString(), providerType: provider.type },
        "admin configuration changed"
      );
      sendJson(response, 201, provider);
      return;
    }

    const providerAccountMatch = /^\/v1\/providers\/([1-9]\d*)\/account-snapshot$/.exec(url.pathname);
    if (request.method === "POST" && providerAccountMatch?.[1]) {
      const providers = this.requireEnergyProviderService();
      const providerId = parsePositiveId(providerAccountMatch[1]);
      const snapshot = await providers.queryAccountSnapshot(providerId);
      if (!snapshot) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      logger.info(
        { action: "provider.account_snapshot", providerId: providerId.toString(), providerType: snapshot.providerType },
        "admin queried provider account status"
      );
      sendJson(response, 200, snapshot);
      return;
    }

    const providerMatch = /^\/v1\/providers\/([1-9]\d*)$/.exec(url.pathname);
    if (request.method === "PATCH" && providerMatch?.[1]) {
      const providers = this.requireEnergyProviderRepository();
      const input = providerUpdateInput.parse(await readJson(request));
      const providerId = parsePositiveId(providerMatch[1]);
      const changesPaidExecutionSettings =
        input.apiKey !== undefined ||
        input.rentTime !== undefined ||
        input.maxEnergyPerOrder !== undefined ||
        input.dailyOrderLimit !== undefined ||
        input.dailyEnergyLimit !== undefined;
      const current = input.enabled === true || changesPaidExecutionSettings
        ? await providers.getProvider(providerId)
        : null;
      if ((input.enabled === true || changesPaidExecutionSettings) && !current) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (changesPaidExecutionSettings && current!.enabled) {
        throw new AdminInputError(
          "Disable the provider before changing credentials, rent time, or budget limits",
          409,
          "provider_must_be_disabled"
        );
      }
      if (input.enabled === true) {
        if (Object.keys(input).length !== 1) {
          throw new AdminInputError("Provider activation must be a separate reviewed action");
        }
        if (!current!.apiKeyConfigured) {
          throw new AdminInputError("Provider credential is not configured");
        }
        const budget = await providers.getBudgetStatus();
        const providerBudget = budget.providers.find((entry) => entry.providerId === providerId);
        if (
          budget.remainingOrders < 1n ||
          budget.remainingEnergy < 1n ||
          !providerBudget ||
          providerBudget.remainingOrders < 1n ||
          providerBudget.remainingEnergy < 1n
        ) {
          throw new AdminInputError("Provider budget is exhausted", 409, "provider_budget_exhausted");
        }
      }
      const provider = await providers.updateProvider(providerId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.rentTime !== undefined ? { rentTime: input.rentTime } : {}),
        ...(input.maxEnergyPerOrder !== undefined ? { maxEnergyPerOrder: input.maxEnergyPerOrder } : {}),
        ...(input.dailyOrderLimit !== undefined ? { dailyOrderLimit: input.dailyOrderLimit } : {}),
        ...(input.dailyEnergyLimit !== undefined ? { dailyEnergyLimit: input.dailyEnergyLimit } : {})
      });
      if (provider) {
        logger.info(
          { action: "provider.update", providerId: provider.id.toString(), providerType: provider.type },
          "admin configuration changed"
        );
      }
      sendJson(response, provider ? 200 : 404, provider ?? { error: "not_found" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/provider-orders") {
      const providers = this.requireEnergyProviderRepository();
      const orders = await providers.listRecentOrders(parseListLimit(url));
      sendJson(response, 200, { orders: orders.map(publicProviderOrder) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/bindings") {
      const input = bindingInput.parse(await readJson(request));
      const address = parseAddress(input.address);
      if (this.runtime.mode === "sponsor" && this.runtime.energySource === "provider") {
        const existing = await this.repository.getBinding(address);
        const effectiveMaximum =
          input.maxTransactions !== undefined ? input.maxTransactions : existing?.maxTransactions ?? null;
        if (effectiveMaximum === null) {
          throw new AdminInputError("A finite maxTransactions value is required for paid external energy");
        }
      }
      const binding = await this.repository.upsertBinding({
        address,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.maxTransactions !== undefined
          ? { maxTransactions: input.maxTransactions === null ? null : BigInt(input.maxTransactions) }
          : {}),
        ...(input.expiresAt !== undefined
          ? { expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt) }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {})
      });
      sendJson(response, 200, binding);
      return;
    }

    const bindingMatch = /^\/v1\/bindings\/([^/]+)$/.exec(url.pathname);
    if (request.method === "PATCH" && bindingMatch?.[1]) {
      const address = parseAddress(decodePathSegment(bindingMatch[1]));
      const input = enabledInput.parse(await readJson(request));
      const changed = await this.repository.setBindingEnabled(address, input.enabled);
      sendJson(response, changed ? 200 : 404, changed ? { address, enabled: input.enabled } : { error: "not_found" });
      return;
    }

    const resetMatch = /^\/v1\/bindings\/([^/]+)\/reset$/.exec(url.pathname);
    if (request.method === "POST" && resetMatch?.[1]) {
      const address = parseAddress(decodePathSegment(resetMatch[1]));
      const input = resetInput.parse(await readJson(request));
      if (
        this.runtime.mode === "sponsor" &&
        this.runtime.energySource === "provider" &&
        input.maxTransactions === null
      ) {
        throw new AdminInputError("maxTransactions cannot be unlimited for paid external energy");
      }
      const existed = await this.repository.getBinding(address);
      if (!existed) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const paidProviderMode =
        this.runtime.mode === "sponsor" && this.runtime.energySource === "provider";
      if (paidProviderMode && await this.repository.hasOpenPaidProviderActivity(address)) {
        sendJson(response, 409, { error: "unresolved_provider_order" });
        return;
      }
      const binding = await this.repository.resetBindingUsage(
        address,
        input.maxTransactions === undefined || input.maxTransactions === null
          ? input.maxTransactions
          : BigInt(input.maxTransactions),
        paidProviderMode
      );
      if (!binding && paidProviderMode && await this.repository.hasOpenPaidProviderActivity(address)) {
        sendJson(response, 409, { error: "unresolved_provider_order" });
        return;
      }
      sendJson(
        response,
        binding ? 200 : 409,
        binding ?? { error: "active_reservations" }
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/requests") {
      const limit = parseListLimit(url);
      sendJson(response, 200, { requests: await this.repository.listRecentRequests(limit) });
      return;
    }

    const requestMatch = /^\/v1\/requests\/([0-9a-fA-F]{64})$/.exec(url.pathname);
    if (request.method === "GET" && requestMatch?.[1]) {
      const value = await this.repository.getRequest(requestMatch[1].toLowerCase());
      sendJson(response, value ? 200 : 404, value ?? { error: "not_found" });
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  private async status(): Promise<Record<string, unknown>> {
    const [database, fullNode, solidityNode, signer, providers, providerBudget] = await Promise.allSettled([
      this.repository.getDashboardStats(),
      this.node.getNodeInfo(),
      this.node.getSolidityNowBlock(),
      this.signer.health(),
      this.energyProviderRepository?.listProviders() ?? Promise.resolve([]),
      this.energyProviderRepository?.getBudgetStatus() ?? Promise.resolve(null)
    ]);
    const fullNodeDetails = fullNode.status === "fulfilled" ? summarizeFullNode(fullNode.value) : null;
    const solidityHeight = solidityNode.status === "fulfilled" ? blockHeight(solidityNode.value) : null;
    const solidHeight = solidityHeight ?? fullNodeDetails?.solidHeight ?? null;
    const lag =
      fullNodeDetails?.height !== null && fullNodeDetails?.height !== undefined && solidHeight !== null
        ? fullNodeDetails.height >= solidHeight
          ? fullNodeDetails.height - solidHeight
          : 0n
        : null;
    return {
      checkedAt: new Date().toISOString(),
      gateway: {
        mode: this.runtime.mode,
        grpcPort: this.runtime.gatewayPort,
        authMode: this.runtime.authMode,
        policies: {
          unsupported: this.runtime.unsupportedPolicy,
          insufficientResources: this.runtime.insufficientPolicy
        },
        sponsorship: {
          energy: this.runtime.sponsorEnergy,
          bandwidth: this.runtime.sponsorBandwidth,
          energySource: this.runtime.energySource,
          ownerBandwidthBurn: {
            enabled: this.runtime.allowOwnerBandwidthBurn,
            maxSun: this.runtime.maxOwnerBandwidthBurnSun
          },
          ownerEnergyBurn: {
            enabled: this.runtime.allowOwnerEnergyBurn,
            maxSun: this.runtime.maxOwnerEnergyBurnSun
          },
          energyPackageThreshold: this.runtime.energyPackageThreshold
        },
        resourceOwner: {
          configured: this.runtime.resourceOwnerAddress !== undefined,
          address: this.runtime.resourceOwnerAddress ?? null
        }
      },
      database:
        database.status === "fulfilled"
          ? { reachable: true, stats: database.value }
          : { reachable: false, stats: null },
      nodes: {
        fullNode: {
          reachable: fullNode.status === "fulfilled",
          height: fullNodeDetails?.height ?? null,
          solidHeight,
          lag,
          connections: fullNodeDetails?.connections ?? { current: null, active: null },
          version: fullNodeDetails?.version ?? null,
          supportConstant: fullNodeDetails?.supportConstant ?? null
        },
        solidityNode: {
          reachable: solidityNode.status === "fulfilled",
          height: solidityHeight
        }
      },
      signer: {
        required: this.runtime.energySource === "self" || this.runtime.sponsorBandwidth,
        reachable: signer.status === "fulfilled" && signer.value === true
      },
      energyProviders: {
        available: this.energyProviderRepository !== undefined,
        configured:
          providers.status === "fulfilled" ? providers.value.length : 0,
        enabled:
          providers.status === "fulfilled"
            ? providers.value.filter((provider) => provider.enabled && provider.apiKeyConfigured).length
            : 0,
        supportedTypes: [KUAIZU_PROVIDER_TYPE],
        budget:
          providerBudget.status === "fulfilled" && providerBudget.value
            ? providerBudget.value
            : {
                window: "UTC_DAY",
                maxEnergyPerOrder: this.runtime.providerMaxEnergyPerOrder,
                dailyOrderLimit: this.runtime.providerDailyMaxOrders,
                dailyEnergyLimit: this.runtime.providerDailyMaxEnergy,
                usedOrders: null,
                usedEnergy: null,
                remainingOrders: null,
                remainingEnergy: null
              }
      }
    };
  }

  private requireEnergyProviderRepository(): EnergyProviderRepository {
    if (!this.energyProviderRepository) {
      throw new AdminInputError(
        "Energy provider storage is unavailable",
        503,
        "provider_storage_unavailable"
      );
    }
    return this.energyProviderRepository;
  }

  private requireEnergyProviderService(): Pick<EnergyProviderService, "queryAccountSnapshot"> {
    if (!this.energyProviderService) {
      throw new AdminInputError(
        "Energy provider account queries are unavailable",
        503,
        "provider_account_query_unavailable"
      );
    }
    return this.energyProviderService;
  }
}

class AdminInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = status >= 500 ? "service_unavailable" : "invalid_request",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AdminInputError";
  }
}

function normalizeAdminError(error: unknown): { status: number; code: string } {
  if (error instanceof AdminInputError) return error;
  if (error instanceof ProviderMustBeDisabledError) {
    return { status: 409, code: "provider_must_be_disabled" };
  }
  if (error instanceof ProviderCredentialError) {
    return { status: 502, code: "provider_credential_unavailable" };
  }
  if (error instanceof ProviderAccountQueryUnsupportedError) {
    return { status: 422, code: "provider_account_query_unsupported" };
  }
  if (error instanceof ProviderAccountQueryError) {
    return { status: 502, code: "provider_account_unavailable" };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError) {
    return { status: 400, code: "invalid_request" };
  }
  const databaseCode =
    error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (databaseCode === "23505") return { status: 409, code: "conflict" };
  if (error instanceof Error && error.message.includes("changed concurrently")) {
    return { status: 409, code: "conflict" };
  }
  return { status: 500, code: "internal_error" };
}

function parseAddress(value: string): string {
  try {
    return normalizeTronAddress(value);
  } catch {
    throw new AdminInputError("Invalid TRON address");
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AdminInputError("Path contains invalid percent encoding");
  }
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

function parseListLimit(url: URL): number {
  if ([...url.searchParams.keys()].some((key) => key !== "limit")) {
    throw new AdminInputError("Unsupported query parameter");
  }
  const values = url.searchParams.getAll("limit");
  if (values.length === 0) return 50;
  const raw = values.length === 1 ? values[0] : undefined;
  if (!raw || !/^[1-9]\d{0,2}$/.test(raw)) throw new AdminInputError("limit must be an integer from 1 to 200");
  const limit = Number(raw);
  if (limit > 200) throw new AdminInputError("limit must be an integer from 1 to 200");
  return limit;
}

function parsePositiveId(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 1n) throw new Error("invalid");
    return parsed;
  } catch {
    throw new AdminInputError("Provider id must be a positive integer");
  }
}

function publicProviderOrder(order: EnergyProviderOrder): Record<string, unknown> {
  return {
    id: order.id,
    txId: order.txId,
    providerId: order.providerId,
    receiveAddress: order.receiveAddress,
    requestedAmount: order.requestedAmount,
    orderedAmount: order.providerId === null ? null : order.amount,
    amount: order.amount,
    rentTime: order.rentTime,
    state: order.state,
    providerOrderId: order.providerOrderId,
    providerBalanceTrx: order.providerBalanceTrx,
    orderCostTrx: order.orderCostTrx,
    delegationTxHash: order.delegationTxHash,
    senderAddresses: order.senderAddresses,
    failureCode: order.failureCode,
    attempts: order.attempts.map((attempt) => ({
      state: attempt.state,
      providerId: attempt.providerId,
      providerType: attempt.providerType,
      requestedAmount: attempt.requestedAmount,
      orderedAmount: attempt.orderedAmount,
      code: attempt.code,
      at: attempt.at
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

function summarizeFullNode(value: Record<string, unknown>): {
  height: bigint | null;
  solidHeight: bigint | null;
  connections: { current: number | null; active: number | null };
  version: string | null;
  supportConstant: boolean | null;
} {
  const config = asRecord(value.configNodeInfo);
  return {
    height: parseNodeInfoHeight(value.block),
    solidHeight: parseNodeInfoHeight(value.solidityBlock),
    connections: {
      current: safeCount(value.currentConnectCount),
      active: safeCount(value.activeConnectCount)
    },
    version: safeText(config?.codeVersion, 100),
    supportConstant: typeof config?.supportConstant === "boolean" ? config.supportConstant : null
  };
}

function blockHeight(value: Record<string, unknown>): bigint | null {
  const header = asRecord(value.block_header);
  const rawData = asRecord(header?.raw_data);
  return nonnegativeBigInt(rawData?.number);
}

function parseNodeInfoHeight(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /(?:^|,)Num:(\d+)(?:,|$)/.exec(value);
  return match?.[1] ? BigInt(match[1]) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function nonnegativeBigInt(value: unknown): bigint | null {
  if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") || value === "") {
    return null;
  }
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AdminInputError("Content-Type must be application/json", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 64 * 1024) throw new AdminInputError("Request body is too large", 413);
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(payload, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...SECURITY_HEADERS
  });
  response.end(body);
}

type WebAsset = { fileName: string; contentType: string };

const WEB_ASSETS = new Map<string, WebAsset>([
  ["/", { fileName: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/index.html", { fileName: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", { fileName: "app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { fileName: "styles.css", contentType: "text/css; charset=utf-8" }]
]);

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
} as const;

async function sendWebAsset(
  response: http.ServerResponse,
  headOnly: boolean,
  webRoot: string,
  asset: WebAsset
): Promise<void> {
  const body = await readFile(path.join(webRoot, asset.fileName));
  response.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": body.length,
    ...SECURITY_HEADERS
  });
  response.end(headOnly ? undefined : body);
}
