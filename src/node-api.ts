type JsonRecord = Record<string, unknown>;

export type ResourcePrices = {
  bandwidthFeeSun: bigint;
  energyFeeSun: bigint;
  maxFeeLimitSun: bigint;
};

export class NodeApiError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly status?: number,
    public readonly response?: unknown
  ) {
    super(message);
    this.name = "NodeApiError";
  }
}

export class TronNodeApi {
  constructor(
    private readonly fullNodeUrl: string,
    private readonly solidityNodeUrl: string,
    private readonly timeoutMs: number
  ) {}

  async full(path: string, body: JsonRecord): Promise<JsonRecord> {
    return this.post(this.fullNodeUrl, path, body);
  }

  async solidity(path: string, body: JsonRecord): Promise<JsonRecord> {
    return this.post(this.solidityNodeUrl, path, body);
  }

  async getAccountResource(address: string): Promise<JsonRecord> {
    return this.full("/wallet/getaccountresource", { address, visible: true });
  }

  async getAccount(address: string): Promise<JsonRecord> {
    return this.full("/wallet/getaccount", { address, visible: true });
  }

  async getResourcePrices(): Promise<ResourcePrices> {
    const response = await this.full("/wallet/getchainparameters", {});
    const parameters = response.chainParameter;
    if (!Array.isArray(parameters)) {
      throw new NodeApiError(
        "Node did not return chainParameter",
        "/wallet/getchainparameters",
        undefined,
        response
      );
    }
    return {
      bandwidthFeeSun: requiredPositiveChainParameter(parameters, "getTransactionFee", response),
      energyFeeSun: requiredPositiveChainParameter(parameters, "getEnergyFee", response),
      maxFeeLimitSun: requiredPositiveChainParameter(parameters, "getMaxFeeLimit", response)
    };
  }

  async matchesTapos(refBlockBytes: Buffer, refBlockHash: Buffer): Promise<boolean> {
    if (refBlockBytes.length !== 2 || refBlockHash.length !== 8) return false;
    const head = await this.full("/wallet/getnowblock", {});
    const headNumber = blockNumber(head, "/wallet/getnowblock");
    const referenceSuffix = BigInt(refBlockBytes.readUInt16BE(0));
    const window = 65_536n;
    let referenceNumber = headNumber - (headNumber % window) + referenceSuffix;
    if (referenceNumber > headNumber) referenceNumber -= window;
    if (referenceNumber < 0n || headNumber - referenceNumber >= window) return false;

    const block = await this.full("/wallet/getblockbynum", {
      num: safeInteger(referenceNumber, "TAPOS block number")
    });
    const blockId = block.blockID;
    if (typeof blockId !== "string" || !/^[0-9a-fA-F]{64}$/.test(blockId)) {
      throw new NodeApiError(
        "Node did not return a valid blockID",
        "/wallet/getblockbynum",
        undefined,
        block
      );
    }
    return Buffer.from(blockId, "hex").subarray(8, 16).equals(refBlockHash);
  }

  async hasTransaction(txId: string): Promise<boolean> {
    if (!/^[0-9a-fA-F]{64}$/.test(txId)) {
      throw new NodeApiError("Invalid transaction ID", "/wallet/gettransactionbyid");
    }

    const storedPath = "/wallet/gettransactionbyid";
    const stored = await this.full(storedPath, { value: txId });
    if (transactionLookupFound(stored, txId, storedPath)) return true;

    const pendingPath = "/wallet/gettransactionfrompending";
    const pending = await this.full(pendingPath, { value: txId });
    return transactionLookupFound(pending, txId, pendingPath);
  }

  async estimateEnergy(input: {
    ownerAddress: string;
    contractAddress: string;
    data: string;
    callValue: bigint;
    callTokenValue: bigint;
    tokenId: bigint;
  }): Promise<bigint> {
    const response = await this.full("/wallet/estimateenergy", {
      owner_address: input.ownerAddress,
      contract_address: input.contractAddress,
      data: input.data,
      call_value: safeInteger(input.callValue, "call_value"),
      call_token_value: safeInteger(input.callTokenValue, "call_token_value"),
      token_id: safeInteger(input.tokenId, "token_id"),
      visible: true
    });
    const result = response.result as JsonRecord | undefined;
    if (result?.result !== true || response.energy_required === undefined) {
      throw new NodeApiError("Energy estimation failed", "/wallet/estimateenergy", undefined, response);
    }
    return BigInt(String(response.energy_required));
  }

  async getCanDelegatedMaxSize(ownerAddress: string, resourceType: "ENERGY" | "BANDWIDTH"): Promise<bigint> {
    const response = await this.full("/wallet/getcandelegatedmaxsize", {
      owner_address: ownerAddress,
      type: resourceType === "ENERGY" ? 1 : 0,
      visible: true
    });
    const value = response.max_size;
    if (value === undefined) {
      throw new NodeApiError(
        "Node did not return max_size",
        "/wallet/getcandelegatedmaxsize",
        undefined,
        response
      );
    }
    return BigInt(String(value));
  }

  async buildDelegation(input: {
    ownerAddress: string;
    receiverAddress: string;
    resourceType: "ENERGY" | "BANDWIDTH";
    balanceSun: bigint;
  }): Promise<JsonRecord> {
    const response = await this.full("/wallet/delegateresource", {
      owner_address: input.ownerAddress,
      receiver_address: input.receiverAddress,
      resource: input.resourceType,
      balance: safeInteger(input.balanceSun, "balance"),
      lock: false,
      visible: true
    });
    return unwrapTransaction(response, "/wallet/delegateresource");
  }

  async buildUndelegation(input: {
    ownerAddress: string;
    receiverAddress: string;
    resourceType: "ENERGY" | "BANDWIDTH";
    balanceSun: bigint;
  }): Promise<JsonRecord> {
    const response = await this.full("/wallet/undelegateresource", {
      owner_address: input.ownerAddress,
      receiver_address: input.receiverAddress,
      resource: input.resourceType,
      balance: safeInteger(input.balanceSun, "balance"),
      visible: true
    });
    return unwrapTransaction(response, "/wallet/undelegateresource");
  }

  async broadcastTransaction(transaction: JsonRecord): Promise<JsonRecord> {
    const response = await this.full("/wallet/broadcasttransaction", transaction);
    if (response.result !== true) {
      throw new NodeApiError("Broadcast was rejected", "/wallet/broadcasttransaction", undefined, response);
    }
    return response;
  }

  async waitForFullNodeReceipt(txId: string, timeoutMs: number, pollMs: number): Promise<JsonRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = await this.full("/wallet/gettransactioninfobyid", { value: txId });
      if (typeof receipt.id === "string" && receipt.id.length > 0) return receipt;
      await delay(pollMs);
    }
    throw new NodeApiError(`Timed out waiting for transaction ${txId}`, "/wallet/gettransactioninfobyid");
  }

  async getSolidifiedReceipt(txId: string): Promise<JsonRecord | null> {
    const response = await this.solidity("/walletsolidity/gettransactioninfobyid", { value: txId });
    return typeof response.id === "string" && response.id.length > 0 ? response : null;
  }

  async getFullNodeReceipt(txId: string): Promise<JsonRecord | null> {
    const response = await this.full("/wallet/gettransactioninfobyid", { value: txId });
    return typeof response.id === "string" && response.id.length > 0 ? response : null;
  }

  async getNodeInfo(): Promise<JsonRecord> {
    return this.full("/wallet/getnodeinfo", {});
  }

  async getSolidityNowBlock(): Promise<JsonRecord> {
    return this.solidity("/walletsolidity/getnowblock", {});
  }

  private async post(baseUrl: string, path: string, body: JsonRecord): Promise<JsonRecord> {
    const url = new URL(path, ensureTrailingSlash(baseUrl));
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new NodeApiError(`Node returned invalid JSON: ${text.slice(0, 200)}`, path, response.status);
    }
    if (!response.ok) {
      throw new NodeApiError(`Node returned HTTP ${response.status}`, path, response.status, parsed);
    }
    return parsed as JsonRecord;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function safeInteger(value: bigint, name: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new RangeError(`${name} exceeds JavaScript safe integer range`);
  return converted;
}

function unwrapTransaction(response: JsonRecord, path: string): JsonRecord {
  const result = response.result as JsonRecord | undefined;
  if (result && result.result === false) {
    throw new NodeApiError("Transaction construction failed", path, undefined, response);
  }
  if (response.transaction && typeof response.transaction === "object") {
    return response.transaction as JsonRecord;
  }
  if (response.raw_data && typeof response.raw_data === "object") return response;
  throw new NodeApiError("Node did not return a transaction", path, undefined, response);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredPositiveChainParameter(
  parameters: readonly unknown[],
  key: string,
  response: JsonRecord
): bigint {
  const matches = parameters.filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return (entry as JsonRecord).key === key;
  });
  if (matches.length !== 1) {
    throw new NodeApiError(
      `Node did not return exactly one ${key}`,
      "/wallet/getchainparameters",
      undefined,
      response
    );
  }
  const value = (matches[0] as JsonRecord).value;
  try {
    if (value === undefined || value === null || value === "") throw new Error("missing");
    const parsed = BigInt(String(value));
    if (parsed <= 0n) throw new Error("not positive");
    return parsed;
  } catch {
    throw new NodeApiError(
      `Node returned an invalid ${key}`,
      "/wallet/getchainparameters",
      undefined,
      response
    );
  }
}

function blockNumber(block: JsonRecord, path: string): bigint {
  const header = block.block_header;
  const rawData = header && typeof header === "object" && !Array.isArray(header)
    ? (header as JsonRecord).raw_data
    : undefined;
  const number = rawData && typeof rawData === "object" && !Array.isArray(rawData)
    ? (rawData as JsonRecord).number
    : undefined;
  try {
    if (number === undefined || number === null || number === "") throw new Error("missing");
    const parsed = BigInt(String(number));
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new NodeApiError("Node did not return a valid block number", path, undefined, block);
  }
}

function transactionLookupFound(response: JsonRecord, expectedTxId: string, path: string): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new NodeApiError("Node returned an invalid transaction lookup response", path, undefined, response);
  }

  const returnedTxId = response.txID;
  if (returnedTxId !== undefined) {
    if (
      typeof returnedTxId !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(returnedTxId) ||
      returnedTxId.toLowerCase() !== expectedTxId.toLowerCase()
    ) {
      throw new NodeApiError("Node returned an unexpected transaction ID", path, undefined, response);
    }
    return true;
  }

  if (Object.keys(response).length === 0) return false;
  throw new NodeApiError("Node returned a malformed transaction lookup response", path, undefined, response);
}
