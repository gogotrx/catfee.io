import { describe, expect, it, vi } from "vitest";
import {
  KUAIZU_BALANCE_ENDPOINT,
  KUAIZU_RENT_ENDPOINT,
  KuaizuEnergyProvider
} from "../src/providers/kuaizu.js";
import {
  AmbiguousProviderError,
  ProviderAccountQueryError
} from "../src/providers/types.js";

const receiveAddress = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const senderAddress = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

describe("KuaizuEnergyProvider", () => {
  it("selects one of Kuaizu's two packages at the default raw-estimate threshold", () => {
    const provider = new KuaizuEnergyProvider();

    expect(provider.resolveEnergyAmount(1)).toBe(65_000);
    expect(provider.resolveEnergyAmount(65_000)).toBe(65_000);
    expect(provider.resolveEnergyAmount(99_999)).toBe(65_000);
    expect(provider.resolveEnergyAmount(100_000)).toBe(131_000);
    expect(provider.resolveEnergyAmount(131_000)).toBe(131_000);
    expect(provider.resolveEnergyAmount(131_001)).toBe(131_000);
    expect(provider.resolveEnergyAmount(0)).toBeNull();
    expect(provider.resolveEnergyAmount(1.5)).toBeNull();
  });

  it("upgrades to 131000 when strict no-burn coverage exceeds the 65000 package", () => {
    const provider = new KuaizuEnergyProvider();

    expect(provider.resolveEnergyAmountAtLeast(72_321, 65_000)).toBe(65_000);
    expect(provider.resolveEnergyAmountAtLeast(72_321, 83_170)).toBe(131_000);
    expect(provider.resolveEnergyAmountAtLeast(72_321, 131_000)).toBe(131_000);
    expect(provider.resolveEnergyAmountAtLeast(72_321, 131_001)).toBeNull();
  });

  it("supports a provider-local package threshold", () => {
    const provider = new KuaizuEnergyProvider({ packageThreshold: 83_171 });

    expect(provider.resolveEnergyAmount(83_170)).toBe(65_000);
    expect(provider.resolveEnergyAmount(83_171)).toBe(131_000);
  });

  it.each([0, -1, 1.5, Number.NaN, 131_001])(
    "rejects invalid package threshold %s during construction",
    (packageThreshold) => {
      expect(() => new KuaizuEnergyProvider({ packageThreshold })).toThrow(
        /integer between 1 and 131000/
      );
    }
  );

  it("uses the fixed endpoint and validates a successful response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      code: 1,
      msg: "",
      data: {
        orderId: 123456789,
        balance: 12.5,
        orderMoney: "2.17",
        hash: "A".repeat(64),
        sendAddressList: senderAddress
      }
    }));
    const provider = new KuaizuEnergyProvider({ fetch: fetchMock as typeof fetch });

    const result = await provider.rentEnergy({
      apiKey: "secret-key",
      receiveAddress,
      amount: 65_000,
      rentTime: 1
    });

    expect(result).toEqual({
      kind: "accepted",
      providerOrderId: "123456789",
      providerBalanceTrx: "12.5",
      orderCostTrx: "2.17",
      delegationTxHash: "a".repeat(64),
      senderAddresses: [senderAddress]
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(KUAIZU_RENT_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({
      apiKey: "secret-key",
      resType: "ENERGY",
      payNums: 65_000,
      rentTime: 1,
      receiveAddress
    });
    expect(init.redirect).toBe("error");
  });

  it("classifies code != 1 as a definite rejection and redacts a reflected key", async () => {
    const apiKey = "do-not-leak-this-key";
    const provider = new KuaizuEnergyProvider({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ code: 0, msg: `bad ${apiKey}` })) as typeof fetch
    });

    const result = await provider.rentEnergy({ apiKey, receiveAddress, amount: 131_000, rentTime: 15 });

    expect(result).toEqual({ kind: "rejected", code: "KUAIZU_0" });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("treats timeout as ambiguous and never retries", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const provider = new KuaizuEnergyProvider({ fetch: fetchMock as typeof fetch, timeoutMs: 5 });

    await expect(provider.rentEnergy({
      apiKey: "secret-key",
      receiveAddress,
      amount: 65_000,
      rentTime: 1
    })).rejects.toMatchObject<Partial<AmbiguousProviderError>>({
      name: "AmbiguousProviderError",
      code: "KUAIZU_NETWORK_AMBIGUOUS"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the abort deadline active while a response body is stalled", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new Error("body aborted")),
            { once: true }
          );
        }
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    });
    const provider = new KuaizuEnergyProvider({ fetch: fetchMock as typeof fetch, timeoutMs: 5 });

    await expect(provider.rentEnergy({
      apiKey: "secret-key",
      receiveAddress,
      amount: 65_000,
      rentTime: 1
    })).rejects.toBeInstanceOf(AmbiguousProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ code: 1, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    new Response("service unavailable", { status: 503, headers: { "content-type": "text/plain" } })
  ])("treats malformed or uncertain HTTP responses as ambiguous", async (response) => {
    const provider = new KuaizuEnergyProvider({
      fetch: vi.fn().mockResolvedValue(response) as typeof fetch
    });
    await expect(provider.rentEnergy({
      apiKey: "secret-key",
      receiveAddress,
      amount: 65_000,
      rentTime: 1
    })).rejects.toBeInstanceOf(AmbiguousProviderError);
  });

  it.each([1, 65_001, 83_170, 130_000, 131_001, 10_000_001])(
    "rejects unsupported package quantity %s before making a request",
    async (amount) => {
    const fetchMock = vi.fn();
    const provider = new KuaizuEnergyProvider({ fetch: fetchMock as typeof fetch });
    await expect(provider.rentEnergy({
      apiKey: "secret-key",
      receiveAddress,
      amount,
      rentTime: 1
    })).rejects.toThrow(/65000 or 131000/);
    expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("queries the fixed balance endpoint without exposing the API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      code: 1,
      msg: "",
      data: { balance: "113.233", price: 30 }
    }));
    const provider = new KuaizuEnergyProvider({ fetch: fetchMock as typeof fetch });

    await expect(provider.queryAccountStatus({ apiKey: "secret-key" })).resolves.toEqual({
      balanceTrx: "113.233",
      priceSunPerEnergy: "30",
      packageAmounts: [65_000, 131_000]
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(KUAIZU_BALANCE_ENDPOINT);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init.body))).toEqual({ apiKey: "secret-key" });
  });

  it("sanitizes balance-query rejections even if the provider reflects the key", async () => {
    const apiKey = "balance-key-must-not-leak";
    const provider = new KuaizuEnergyProvider({
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        code: 0,
        msg: `invalid ${apiKey}`
      })) as typeof fetch
    });

    const error = await provider.queryAccountStatus({ apiKey }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "ProviderAccountQueryError",
      code: "KUAIZU_BALANCE_0"
    });
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(apiKey);
  });

  it.each([
    new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
    jsonResponse({ code: 1, data: { balance: 10, price: 0 } }),
    jsonResponse({ code: 1, data: { balance: 1e-7, price: 30 } }),
    jsonResponse({ code: 1, data: { balance: "1.1234567890123456789", price: 30 } }),
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "65537" }
    }),
    new Response("service unavailable", { status: 503, headers: { "content-type": "text/plain" } })
  ])("rejects invalid balance responses without creating an ambiguous rent result", async (response) => {
    const provider = new KuaizuEnergyProvider({
      fetch: vi.fn().mockResolvedValue(response) as typeof fetch
    });

    await expect(provider.queryAccountStatus({ apiKey: "secret-key" }))
      .rejects.toBeInstanceOf(ProviderAccountQueryError);
  });

  it("applies the abort deadline to the balance query", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const provider = new KuaizuEnergyProvider({ fetch: fetchMock as typeof fetch, timeoutMs: 5 });

    await expect(provider.queryAccountStatus({ apiKey: "secret-key" })).rejects.toMatchObject({
      name: "ProviderAccountQueryError",
      code: "KUAIZU_BALANCE_NETWORK_ERROR"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
