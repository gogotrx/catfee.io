import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeApiError, TronNodeApi } from "../src/node-api.js";

describe("TronNodeApi resource prices", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads bandwidth and energy prices from current chain parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      chainParameter: [
        { key: "getTransactionFee", value: 1_000 },
        { key: "getEnergyFee", value: 100 },
        { key: "getMaxFeeLimit", value: 15_000_000_000 }
      ]
    }));
    vi.stubGlobal("fetch", fetchMock);
    const node = new TronNodeApi("http://127.0.0.1:8090", "http://127.0.0.1:8091", 1_000);

    await expect(node.getResourcePrices()).resolves.toEqual({
      bandwidthFeeSun: 1_000n,
      energyFeeSun: 100n,
      maxFeeLimitSun: 15_000_000_000n
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8090/wallet/getchainparameters"),
      expect.objectContaining({ method: "POST", body: "{}" })
    );
  });

  it.each([
    { chainParameter: [{ key: "getTransactionFee", value: 1_000 }] },
    { chainParameter: [
      { key: "getTransactionFee", value: 1_000 },
      { key: "getTransactionFee", value: 1_000 },
      { key: "getEnergyFee", value: 100 },
      { key: "getMaxFeeLimit", value: 15_000_000_000 }
    ] },
    { chainParameter: [
      { key: "getTransactionFee", value: 0 },
      { key: "getEnergyFee", value: 100 },
      { key: "getMaxFeeLimit", value: 15_000_000_000 }
    ] }
  ])("fails closed when chain prices are missing, duplicated, or invalid", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));
    const node = new TronNodeApi("http://127.0.0.1:8090", "http://127.0.0.1:8091", 1_000);

    await expect(node.getResourcePrices()).rejects.toBeInstanceOf(NodeApiError);
  });

  it("matches a TAPOS reference against the canonical recent block", async () => {
    const referenceNumber = 69_999;
    const referenceBytes = Buffer.alloc(2);
    referenceBytes.writeUInt16BE(referenceNumber & 0xffff);
    const referenceHash = Buffer.from("0102030405060708", "hex");
    const blockId = Buffer.concat([
      Buffer.alloc(8),
      referenceHash,
      Buffer.alloc(16)
    ]).toString("hex");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ block_header: { raw_data: { number: 70_000 } } }))
      .mockResolvedValueOnce(jsonResponse({ blockID: blockId }));
    vi.stubGlobal("fetch", fetchMock);
    const node = new TronNodeApi("http://127.0.0.1:8090", "http://127.0.0.1:8091", 1_000);

    await expect(node.matchesTapos(referenceBytes, referenceHash)).resolves.toBe(true);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ num: referenceNumber })
    }));
  });
});

describe("TronNodeApi transaction existence", () => {
  const txId = "ab".repeat(32);

  afterEach(() => vi.unstubAllGlobals());

  it("returns true when the transaction is in the node transaction store", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ txID: txId, raw_data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const node = createNode();

    await expect(node.hasTransaction(txId)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8090/wallet/gettransactionbyid"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ value: txId }) })
    );
  });

  it("checks the pending pool after a definite miss and returns true when found there", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ txID: txId.toUpperCase(), raw_data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const node = createNode();

    await expect(node.hasTransaction(txId)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual([
      new URL("http://127.0.0.1:8090/wallet/gettransactionfrompending"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ value: txId }) })
    ]);
  });

  it("returns false only when both transaction lookups are empty", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", fetchMock);
    const node = createNode();

    await expect(node.hasTransaction(txId)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the stored-transaction lookup has a node error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const node = createNode();

    await expect(node.hasTransaction(txId)).rejects.toMatchObject({
      name: "NodeApiError",
      path: "/wallet/gettransactionbyid",
      status: 503
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the pending lookup has a node error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    const node = createNode();

    await expect(node.hasTransaction(txId)).rejects.toMatchObject({
      name: "NodeApiError",
      path: "/wallet/gettransactionfrompending",
      status: 500
    });
  });

  it.each([
    { response: { txID: "cd".repeat(32) }, reason: "mismatched transaction ID" },
    { response: { txID: "not-a-transaction-id" }, reason: "invalid transaction ID" },
    { response: { raw_data: {} }, reason: "nonempty response without txID" }
  ])("fails closed for a $reason", async ({ response }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(response)));
    const node = createNode();

    await expect(node.hasTransaction(txId)).rejects.toBeInstanceOf(NodeApiError);
  });

  it("rejects an invalid requested transaction ID without querying the node", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const node = createNode();

    await expect(node.hasTransaction("not-a-transaction-id")).rejects.toMatchObject({
      name: "NodeApiError",
      path: "/wallet/gettransactionbyid"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createNode(): TronNodeApi {
  return new TronNodeApi("http://127.0.0.1:8090", "http://127.0.0.1:8091", 1_000);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
