import { createHash, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import { pathToFileURL } from "node:url";
import { TronWeb } from "tronweb";
import { z } from "zod";
import { normalizeTronAddress } from "./tron-address.js";

type JsonRecord = Record<string, unknown>;

const signerConfigSchema = z.object({
  SIGNER_LISTEN_HOST: z.string().default("127.0.0.1"),
  SIGNER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  SIGNER_TOKEN: z.string().min(32),
  RESOURCE_PRIVATE_KEY: z.string().regex(/^(?:0x)?[0-9a-fA-F]{64}$/),
  RESOURCE_OWNER_ADDRESS: z.string().min(1),
  SIGNER_MAX_DELEGATE_SUN: z.coerce.bigint().positive().default(100_000_000n)
});

export async function startSignerServer(environment: NodeJS.ProcessEnv = process.env): Promise<http.Server> {
  const config = signerConfigSchema.parse(environment);
  if (!isLoopback(config.SIGNER_LISTEN_HOST)) {
    throw new Error("The signing service must listen on a loopback IP address");
  }
  const privateKey = config.RESOURCE_PRIVATE_KEY.replace(/^0x/, "");
  const configuredOwner = normalizeTronAddress(config.RESOURCE_OWNER_ADDRESS);
  const derivedOwner = TronWeb.address.fromPrivateKey(privateKey);
  if (!derivedOwner || normalizeTronAddress(derivedOwner) !== configuredOwner) {
    throw new Error("RESOURCE_PRIVATE_KEY does not match RESOURCE_OWNER_ADDRESS");
  }

  // trx.sign and txCheck are local-only; this deliberately unreachable
  // provider prevents the signer from depending on a node endpoint.
  const tronWeb = new TronWeb({ fullHost: "http://127.0.0.1:9" });
  const server = http.createServer((request, response) => {
    void handle(request, response, {
      token: config.SIGNER_TOKEN,
      privateKey,
      ownerAddress: configuredOwner,
      maxDelegateSun: config.SIGNER_MAX_DELEGATE_SUN,
      tronWeb
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Signing request failed";
      sendJson(response, 400, { error: message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(config.SIGNER_PORT, config.SIGNER_LISTEN_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  process.stdout.write(`signer listening on ${config.SIGNER_LISTEN_HOST}:${config.SIGNER_PORT}\n`);
  return server;
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: {
    token: string;
    privateKey: string;
    ownerAddress: string;
    maxDelegateSun: bigint;
    tronWeb: TronWeb;
  }
): Promise<void> {
  if (request.method === "GET" && request.url === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (!authorized(request.headers.authorization, context.token)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/sign") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  const payload = (await readJson(request)) as { transaction?: JsonRecord };
  if (!payload.transaction || typeof payload.transaction !== "object") throw new Error("transaction is required");
  validateResourceTransaction(payload.transaction, context.ownerAddress, context.maxDelegateSun);
  const signed = (await context.tronWeb.trx.sign(payload.transaction as never, context.privateKey)) as unknown as JsonRecord;
  sendJson(response, 200, { signedTransaction: signed });
}

export function validateResourceTransaction(
  transaction: JsonRecord,
  resourceOwnerAddress: string,
  maxDelegateSun: bigint
): void {
  const rawData = transaction.raw_data as JsonRecord | undefined;
  const contracts = rawData?.contract;
  if (!Array.isArray(contracts) || contracts.length !== 1) throw new Error("Exactly one resource contract is required");
  const contract = contracts[0] as JsonRecord;
  const type = String(contract.type ?? "");
  if (type !== "DelegateResourceContract" && type !== "UnDelegateResourceContract") {
    throw new Error("Only resource delegation and undelegation may be signed");
  }
  const parameter = contract.parameter as JsonRecord | undefined;
  const value = parameter?.value as JsonRecord | undefined;
  if (!value) throw new Error("Resource contract value is missing");

  const owner = normalizeTronAddress(String(value.owner_address ?? ""));
  if (owner !== resourceOwnerAddress) throw new Error("Resource contract owner does not match the signing wallet");
  const receiver = normalizeTronAddress(String(value.receiver_address ?? ""));
  if (receiver === owner) throw new Error("Resource receiver must differ from the resource owner");
  const resource = String(value.resource ?? "");
  if (resource !== "ENERGY" && resource !== "BANDWIDTH") throw new Error("Invalid resource type");
  if (type === "DelegateResourceContract" && (value.lock === true || BigInt(String(value.lock_period ?? "0")) > 0n)) {
    throw new Error("Locked resource delegation is forbidden");
  }
  const balance = BigInt(String(value.balance ?? "0"));
  if (balance <= 0n || balance > maxDelegateSun) throw new Error("Resource balance exceeds signer policy");
  const expiration = BigInt(String(rawData?.expiration ?? "0"));
  if (expiration <= BigInt(Date.now())) throw new Error("Resource transaction has expired");
}

function isLoopback(host: string): boolean {
  return host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expectedToken).digest()
  );
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 512 * 1024) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store"
  });
  response.end(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startSignerServer().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`signer startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
