type JsonRecord = Record<string, unknown>;

export class SignerClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs: number
  ) {}

  async sign(transaction: JsonRecord): Promise<JsonRecord> {
    const response = await fetch(new URL("/v1/sign", ensureTrailingSlash(this.url)), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify({ transaction }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const payload = (await response.json()) as {
      signedTransaction?: JsonRecord;
      error?: string;
    };
    if (!response.ok || !payload.signedTransaction) {
      throw new Error(`Signer rejected transaction: ${payload.error ?? response.status}`);
    }
    return payload.signedTransaction;
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(new URL("/healthz", ensureTrailingSlash(this.url)), {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { status?: unknown };
      return payload.status === "ok";
    } catch {
      return false;
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
