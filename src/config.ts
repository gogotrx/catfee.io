import { z } from "zod";
import { normalizeTronAddress } from "./tron-address.js";

const booleanValue = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((value) => value === "true");

const configSchema = z
  .object({
    GATEWAY_MODE: z.enum(["passthrough", "observe", "sponsor"]).default("observe"),
    GATEWAY_LISTEN_HOST: z.string().default("0.0.0.0"),
    GATEWAY_GRPC_PORT: z.coerce.number().int().min(1).max(65535).default(50051),
    MAX_BROADCAST_BYTES: z.coerce.number().int().min(1024).default(4_194_304),

    UPSTREAM_GRPC_URL: z.string().url(),
    NODE_HTTP_URL: z.string().url(),
    NODE_SOLIDITY_HTTP_URL: z.string().url(),
    NODE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    DATABASE_URL: z.string().min(1),

    ADMIN_LISTEN_HOST: z.string().default("127.0.0.1"),
    ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    ADMIN_TOKEN: z.string().min(32),

    AUTH_MODE: z.enum(["none", "bound_address"]).default("bound_address"),
    AUTH_ENFORCE_IN_OBSERVE: booleanValue("false"),
    ALLOWED_CONTRACTS: z.string().default("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
    ALLOWED_SELECTORS: z.string().default("a9059cbb,095ea7b3"),
    UNSUPPORTED_POLICY: z.enum(["forward", "reject"]).default("reject"),
    INSUFFICIENT_POLICY: z.enum(["forward", "reject"]).default("reject"),
    MIN_TRANSACTION_TTL_MS: z.coerce.number().int().min(0).default(5_000),
    MAX_TRANSACTION_TTL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(600_000),
    MAX_TRANSACTION_AGE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
    MAX_TRANSACTION_FUTURE_SKEW_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),

    SPONSOR_ENERGY: booleanValue("true"),
    SPONSOR_BANDWIDTH: booleanValue("true"),
    ENERGY_SOURCE: z.enum(["self", "provider"]).default("self"),
    ESTIMATE_SAFETY_BPS: z.coerce.number().int().min(10_000).max(30_000).default(11_500),
    ALLOW_OWNER_BANDWIDTH_BURN: booleanValue("false"),
    MAX_OWNER_BANDWIDTH_BURN_SUN: z.coerce.number().int().min(1).max(15_000_000_000).default(1_000_000),
    ALLOW_OWNER_ENERGY_BURN: booleanValue("false"),
    MAX_OWNER_ENERGY_BURN_SUN: z.coerce.number().int().min(1).max(15_000_000_000).default(5_000_000),
    MIN_DELEGATE_SUN: z.coerce.number().int().min(1_000_000).default(1_000_000),
    RESOURCE_OWNER_ADDRESS: z.string().optional(),
    DELEGATION_CONFIRM_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
    DELEGATION_POLL_MS: z.coerce.number().int().positive().default(400),

    PROVIDER_MASTER_KEY: z.string().optional(),
    PROVIDER_ORDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
    PROVIDER_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
    PROVIDER_POLL_MS: z.coerce.number().int().min(100).max(10_000).default(250),
    KUAIZU_PACKAGE_THRESHOLD: z.coerce.number().int().min(1).max(131_000).default(100_000),
    PROVIDER_MAX_ENERGY_PER_ORDER: z.coerce.number().int().min(1).max(10_000_000).default(200_000),
    PROVIDER_DAILY_MAX_ORDERS: z.coerce.number().int().min(1).max(1_000_000).default(20),
    PROVIDER_DAILY_MAX_ENERGY: z.coerce.number().int().min(1).max(1_000_000_000).default(2_000_000),

    SIGNER_URL: z.string().url().default("http://127.0.0.1:8787"),
    SIGNER_TOKEN: z.string().min(32),

    CONFIRMATION_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),
    RECLAIM_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    RECLAIM_DELAY_MS: z.coerce.number().int().min(0).default(15_000),
    LOG_LEVEL: z.string().default("info")
  })
  .superRefine((value, context) => {
    const needsSelfManagedResources =
      (value.SPONSOR_ENERGY && value.ENERGY_SOURCE === "self") || value.SPONSOR_BANDWIDTH;
    if (value.GATEWAY_MODE === "sponsor" && needsSelfManagedResources && !value.RESOURCE_OWNER_ADDRESS) {
      context.addIssue({
        code: "custom",
        path: ["RESOURCE_OWNER_ADDRESS"],
        message: "RESOURCE_OWNER_ADDRESS is required for self-managed ENERGY or BANDWIDTH sponsorship"
      });
    }
    if (value.ENERGY_SOURCE === "provider") {
      const key = value.PROVIDER_MASTER_KEY;
      const validHex = key ? /^[0-9a-fA-F]{64}$/.test(key) : false;
      const validBase64 = key ? isBase64Key(key) : false;
      if (!validHex && !validBase64) {
        context.addIssue({
          code: "custom",
          path: ["PROVIDER_MASTER_KEY"],
          message: "PROVIDER_MASTER_KEY must encode exactly 32 bytes"
        });
      }
    }
    if (value.GATEWAY_MODE === "sponsor" && value.ENERGY_SOURCE === "provider") {
      if (!value.SPONSOR_ENERGY) {
        context.addIssue({
          code: "custom",
          path: ["SPONSOR_ENERGY"],
          message: "SPONSOR_ENERGY must be true when ENERGY_SOURCE=provider"
        });
      }
      if (value.SPONSOR_BANDWIDTH) {
        context.addIssue({
          code: "custom",
          path: ["SPONSOR_BANDWIDTH"],
          message: "SPONSOR_BANDWIDTH must be false in paid provider-only mode"
        });
      }
      if (value.AUTH_MODE !== "bound_address") {
        context.addIssue({
          code: "custom",
          path: ["AUTH_MODE"],
          message: "AUTH_MODE must be bound_address for paid external energy"
        });
      }
      if (value.INSUFFICIENT_POLICY !== "reject") {
        context.addIssue({
          code: "custom",
          path: ["INSUFFICIENT_POLICY"],
          message: "INSUFFICIENT_POLICY must be reject for paid external energy"
        });
      }
      if (value.UNSUPPORTED_POLICY !== "reject") {
        context.addIssue({
          code: "custom",
          path: ["UNSUPPORTED_POLICY"],
          message: "UNSUPPORTED_POLICY must be reject for paid external energy"
        });
      }
      if (value.ALLOW_OWNER_ENERGY_BURN) {
        context.addIssue({
          code: "custom",
          path: ["ALLOW_OWNER_ENERGY_BURN"],
          message: "ALLOW_OWNER_ENERGY_BURN must be false for paid external energy"
        });
      }
    }
    if (value.PROVIDER_DAILY_MAX_ENERGY < value.PROVIDER_MAX_ENERGY_PER_ORDER) {
      context.addIssue({
        code: "custom",
        path: ["PROVIDER_DAILY_MAX_ENERGY"],
        message: "PROVIDER_DAILY_MAX_ENERGY must be at least PROVIDER_MAX_ENERGY_PER_ORDER"
      });
    }
    if (value.MAX_TRANSACTION_TTL_MS < value.MIN_TRANSACTION_TTL_MS) {
      context.addIssue({
        code: "custom",
        path: ["MAX_TRANSACTION_TTL_MS"],
        message: "MAX_TRANSACTION_TTL_MS must be at least MIN_TRANSACTION_TTL_MS"
      });
    }
  });

export type AppConfig = ReturnType<typeof loadConfig>;

function csvSet(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function addressSet(value: string): ReadonlySet<string> {
  return new Set([...csvSet(value)].map(normalizeTronAddress));
}

function selectorSet(value: string): ReadonlySet<string> {
  const selectors = [...csvSet(value)].map((entry) => entry.toLowerCase());
  if (selectors.some((entry) => !/^[0-9a-f]{8}$/.test(entry))) {
    throw new Error("ALLOWED_SELECTORS entries must be four-byte hexadecimal selectors");
  }
  return new Set(selectors);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = configSchema.parse(environment);
  return {
    mode: parsed.GATEWAY_MODE,
    gatewayHost: parsed.GATEWAY_LISTEN_HOST,
    gatewayPort: parsed.GATEWAY_GRPC_PORT,
    maxBroadcastBytes: parsed.MAX_BROADCAST_BYTES,
    upstreamGrpcUrl: parsed.UPSTREAM_GRPC_URL,
    nodeHttpUrl: parsed.NODE_HTTP_URL,
    nodeSolidityHttpUrl: parsed.NODE_SOLIDITY_HTTP_URL,
    nodeRequestTimeoutMs: parsed.NODE_REQUEST_TIMEOUT_MS,
    databaseUrl: parsed.DATABASE_URL,
    adminHost: parsed.ADMIN_LISTEN_HOST,
    adminPort: parsed.ADMIN_PORT,
    adminToken: parsed.ADMIN_TOKEN,
    authMode: parsed.AUTH_MODE,
    authEnforceInObserve: parsed.AUTH_ENFORCE_IN_OBSERVE,
    allowedContracts: addressSet(parsed.ALLOWED_CONTRACTS),
    allowedSelectors: selectorSet(parsed.ALLOWED_SELECTORS),
    unsupportedPolicy: parsed.UNSUPPORTED_POLICY,
    insufficientPolicy: parsed.INSUFFICIENT_POLICY,
    minTransactionTtlMs: parsed.MIN_TRANSACTION_TTL_MS,
    maxTransactionTtlMs: parsed.MAX_TRANSACTION_TTL_MS,
    maxTransactionAgeMs: parsed.MAX_TRANSACTION_AGE_MS,
    maxTransactionFutureSkewMs: parsed.MAX_TRANSACTION_FUTURE_SKEW_MS,
    sponsorEnergy: parsed.SPONSOR_ENERGY,
    sponsorBandwidth: parsed.SPONSOR_BANDWIDTH,
    energySource: parsed.ENERGY_SOURCE,
    estimateSafetyBps: parsed.ESTIMATE_SAFETY_BPS,
    allowOwnerBandwidthBurn: parsed.ALLOW_OWNER_BANDWIDTH_BURN,
    maxOwnerBandwidthBurnSun: BigInt(parsed.MAX_OWNER_BANDWIDTH_BURN_SUN),
    allowOwnerEnergyBurn: parsed.ALLOW_OWNER_ENERGY_BURN,
    maxOwnerEnergyBurnSun: BigInt(parsed.MAX_OWNER_ENERGY_BURN_SUN),
    minDelegateSun: BigInt(parsed.MIN_DELEGATE_SUN),
    resourceOwnerAddress: parsed.RESOURCE_OWNER_ADDRESS
      ? normalizeTronAddress(parsed.RESOURCE_OWNER_ADDRESS)
      : undefined,
    delegationConfirmTimeoutMs: parsed.DELEGATION_CONFIRM_TIMEOUT_MS,
    delegationPollMs: parsed.DELEGATION_POLL_MS,
    providerMasterKey: parsed.PROVIDER_MASTER_KEY,
    providerOrderTimeoutMs: parsed.PROVIDER_ORDER_TIMEOUT_MS,
    providerConfirmTimeoutMs: parsed.PROVIDER_CONFIRM_TIMEOUT_MS,
    providerPollMs: parsed.PROVIDER_POLL_MS,
    kuaizuPackageThreshold: parsed.KUAIZU_PACKAGE_THRESHOLD,
    providerMaxEnergyPerOrder: parsed.PROVIDER_MAX_ENERGY_PER_ORDER,
    providerDailyMaxOrders: parsed.PROVIDER_DAILY_MAX_ORDERS,
    providerDailyMaxEnergy: parsed.PROVIDER_DAILY_MAX_ENERGY,
    signerUrl: parsed.SIGNER_URL,
    signerToken: parsed.SIGNER_TOKEN,
    confirmationIntervalMs: parsed.CONFIRMATION_INTERVAL_MS,
    reclaimIntervalMs: parsed.RECLAIM_INTERVAL_MS,
    reclaimDelayMs: parsed.RECLAIM_DELAY_MS,
    logLevel: parsed.LOG_LEVEL
  } as const;
}

function isBase64Key(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}
