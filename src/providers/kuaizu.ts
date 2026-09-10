import { z } from "zod";
import { normalizeTronAddress } from "../tron-address.js";
import {
  AmbiguousProviderError,
  type EnergyProviderAdapter,
  ProviderAccountQueryError,
  type ProviderAccountStatus,
  type QueryProviderAccountRequest,
  type RentEnergyRequest,
  type RentEnergyResult
} from "./types.js";

export const KUAIZU_PROVIDER_TYPE = "kuaizu";
export const KUAIZU_RENT_ENDPOINT = "https://api.kuaizu.io/api/rent";
export const KUAIZU_BALANCE_ENDPOINT = "https://api.kuaizu.io/api/balance";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
export const KUAIZU_SINGLE_PACKAGE = 65_000;
export const KUAIZU_DOUBLE_PACKAGE = 131_000;
export const KUAIZU_DEFAULT_PACKAGE_THRESHOLD = 100_000;
const decimalSchema = z.union([
  z.number().finite().nonnegative().max(99_999_999_999_999_999_999),
  z.string().regex(/^\d+(?:\.\d+)?$/).max(64)
]);
const orderIdSchema = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/).min(1).max(128)
]);
const envelopeSchema = z.object({
  code: z.number().int().safe(),
  msg: z.string().max(1_000).optional(),
  data: z.unknown().optional()
});
const successSchema = z.object({
  code: z.literal(1),
  msg: z.string().max(1_000).optional(),
  data: z.object({
    orderId: orderIdSchema,
    balance: decimalSchema,
    orderMoney: decimalSchema,
    hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    sendAddressList: z.union([
      z.string().min(1).max(2_000),
      z.array(z.string().min(1).max(128)).min(1).max(100)
    ])
  })
});
const accountSuccessSchema = z.object({
  code: z.literal(1),
  msg: z.string().max(1_000).optional(),
  data: z.object({
    balance: decimalSchema,
    price: decimalSchema
  })
});

export type KuaizuAdapterOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  packageThreshold?: number;
};

export class KuaizuEnergyProvider implements EnergyProviderAdapter {
  readonly type = KUAIZU_PROVIDER_TYPE;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly packageThreshold: number;

  constructor(options: KuaizuAdapterOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = boundedPositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000);
    this.maxResponseBytes = boundedPositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1024 * 1024
    );
    this.packageThreshold = boundedPositiveInteger(
      options.packageThreshold ?? KUAIZU_DEFAULT_PACKAGE_THRESHOLD,
      KUAIZU_DOUBLE_PACKAGE
    );
  }

  resolveEnergyAmount(requestedAmount: number): number | null {
    if (!Number.isSafeInteger(requestedAmount) || requestedAmount < 1) return null;
    return requestedAmount < this.packageThreshold
      ? KUAIZU_SINGLE_PACKAGE
      : KUAIZU_DOUBLE_PACKAGE;
  }

  resolveEnergyAmountAtLeast(requestedAmount: number, minimumAmount: number): number | null {
    if (!Number.isSafeInteger(minimumAmount) || minimumAmount < 1) return null;
    const resolved = this.resolveEnergyAmount(requestedAmount);
    if (resolved === null) return null;
    if (resolved >= minimumAmount) return resolved;
    return KUAIZU_DOUBLE_PACKAGE >= minimumAmount ? KUAIZU_DOUBLE_PACKAGE : null;
  }

  async rentEnergy(request: RentEnergyRequest): Promise<RentEnergyResult> {
    validateRequest(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      let response: Response;
      try {
        response = await this.fetchImplementation(KUAIZU_RENT_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            apiKey: request.apiKey,
            resType: "ENERGY",
            payNums: request.amount,
            rentTime: request.rentTime,
            receiveAddress: request.receiveAddress
          }),
          redirect: "error",
          signal: controller.signal
        });
      } catch {
        throw new AmbiguousProviderError("KUAIZU_NETWORK_AMBIGUOUS");
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new AmbiguousProviderError("KUAIZU_HTTP_AMBIGUOUS");
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) {
        await response.body?.cancel().catch(() => undefined);
        throw new AmbiguousProviderError("KUAIZU_RESPONSE_INVALID");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await readLimitedBody(
          response,
          this.maxResponseBytes,
          (reason) => new AmbiguousProviderError(
            reason === "too_large" ? "KUAIZU_RESPONSE_TOO_LARGE" : "KUAIZU_RESPONSE_INVALID"
          )
        )) as unknown;
      } catch (error) {
        if (error instanceof AmbiguousProviderError) throw error;
        throw new AmbiguousProviderError("KUAIZU_RESPONSE_INVALID");
      }
      const envelope = envelopeSchema.safeParse(payload);
      if (!envelope.success) throw new AmbiguousProviderError("KUAIZU_RESPONSE_INVALID");
      if (envelope.data.code !== 1) {
        return {
          kind: "rejected",
          code: `KUAIZU_${envelope.data.code}`.slice(0, 100)
        };
      }

      const parsed = successSchema.safeParse(payload);
      if (!parsed.success) throw new AmbiguousProviderError("KUAIZU_RESPONSE_INVALID");
      return {
        kind: "accepted",
        providerOrderId: String(parsed.data.data.orderId),
        providerBalanceTrx: normalizeDecimal(parsed.data.data.balance),
        orderCostTrx: normalizeDecimal(parsed.data.data.orderMoney),
        delegationTxHash: parsed.data.data.hash.toLowerCase(),
        senderAddresses: normalizeSenderAddresses(parsed.data.data.sendAddressList)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async queryAccountStatus(request: QueryProviderAccountRequest): Promise<ProviderAccountStatus> {
    validateApiKey(request.apiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      let response: Response;
      try {
        response = await this.fetchImplementation(KUAIZU_BALANCE_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({ apiKey: request.apiKey }),
          redirect: "error",
          signal: controller.signal
        });
      } catch {
        throw new ProviderAccountQueryError("KUAIZU_BALANCE_NETWORK_ERROR");
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderAccountQueryError("KUAIZU_BALANCE_HTTP_ERROR");
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderAccountQueryError("KUAIZU_BALANCE_RESPONSE_INVALID");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await readLimitedBody(
          response,
          this.maxResponseBytes,
          (reason) => new ProviderAccountQueryError(
            reason === "too_large"
              ? "KUAIZU_BALANCE_RESPONSE_TOO_LARGE"
              : "KUAIZU_BALANCE_RESPONSE_INVALID"
          )
        )) as unknown;
      } catch (error) {
        if (error instanceof ProviderAccountQueryError) throw error;
        throw new ProviderAccountQueryError("KUAIZU_BALANCE_RESPONSE_INVALID");
      }
      const envelope = envelopeSchema.safeParse(payload);
      if (!envelope.success) {
        throw new ProviderAccountQueryError("KUAIZU_BALANCE_RESPONSE_INVALID");
      }
      if (envelope.data.code !== 1) {
        throw new ProviderAccountQueryError(`KUAIZU_BALANCE_${envelope.data.code}`.slice(0, 100));
      }

      const parsed = accountSuccessSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ProviderAccountQueryError("KUAIZU_BALANCE_RESPONSE_INVALID");
      }
      const balanceTrx = normalizeAccountDecimal(parsed.data.data.balance);
      const priceSunPerEnergy = normalizeAccountDecimal(parsed.data.data.price);
      if (!/[1-9]/.test(priceSunPerEnergy)) {
        throw new ProviderAccountQueryError("KUAIZU_BALANCE_RESPONSE_INVALID");
      }
      return {
        balanceTrx,
        priceSunPerEnergy,
        packageAmounts: [KUAIZU_SINGLE_PACKAGE, KUAIZU_DOUBLE_PACKAGE]
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readLimitedBody(
  response: Response,
  maximumBytes: number,
  errorFor: (reason: "invalid" | "too_large") => Error
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw errorFor("too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw errorFor("too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AmbiguousProviderError || error instanceof ProviderAccountQueryError) throw error;
    throw errorFor("invalid");
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function normalizeSenderAddresses(value: string | readonly string[]): readonly string[] {
  const candidates = typeof value === "string" ? value.split(",") : value;
  if (candidates.length < 1 || candidates.length > 100) {
    throw new AmbiguousProviderError("KUAIZU_RESPONSE_INVALID");
  }
  try {
    return candidates.map((address) => normalizeTronAddress(address.trim()));
  } catch {
    throw new AmbiguousProviderError("KUAIZU_RESPONSE_INVALID");
  }
}

function validateRequest(request: RentEnergyRequest): void {
  validateApiKey(request.apiKey);
  if (
    !Number.isSafeInteger(request.amount) ||
    (request.amount !== KUAIZU_SINGLE_PACKAGE && request.amount !== KUAIZU_DOUBLE_PACKAGE)
  ) {
    throw new RangeError(
      `Kuaizu energy amount must be exactly ${KUAIZU_SINGLE_PACKAGE} or ${KUAIZU_DOUBLE_PACKAGE}`
    );
  }
  if (request.rentTime !== 1 && request.rentTime !== 15) {
    throw new RangeError("Kuaizu rentTime must be 1 or 15");
  }
  normalizeTronAddress(request.receiveAddress);
}

function validateApiKey(apiKey: string): void {
  if (!apiKey || apiKey.length > 512 || apiKey.trim() !== apiKey) {
    throw new Error("Kuaizu API key is not configured correctly");
  }
}

function boundedPositiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`Value must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeDecimal(value: string | number): string {
  const decimal = String(value);
  if (!/^\d{1,20}(?:\.\d{1,18})?$/.test(decimal)) {
    throw new AmbiguousProviderError("KUAIZU_RESPONSE_INVALID");
  }
  return decimal;
}

function normalizeAccountDecimal(value: string | number): string {
  try {
    return normalizeDecimal(value);
  } catch {
    throw new ProviderAccountQueryError("KUAIZU_BALANCE_RESPONSE_INVALID");
  }
}
