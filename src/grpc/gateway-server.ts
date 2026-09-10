import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { BroadcastProcessor } from "../broadcast-processor.js";
import { BROADCAST_PATH, ReturnCode, type RawGrpcResponse } from "../domain.js";
import { logger } from "../logger.js";
import { encodeReturnFrame } from "./protocol.js";
import { isApprovedProxyPath } from "./upstream-policy.js";
import { UpstreamGrpc } from "./upstream.js";

export class GatewayServer {
  private readonly server = http2.createServer();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly maxBroadcastBytes: number,
    private readonly processor: BroadcastProcessor,
    private readonly upstream: UpstreamGrpc
  ) {
    this.server.on("stream", (stream, headers) => this.onStream(stream, headers));
    this.server.on("sessionError", (error) => logger.warn({ err: error }, "downstream HTTP/2 session error"));
    this.server.on("error", (error) => logger.error({ err: error }, "gRPC gateway server error"));
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
    logger.info({ host: this.host, port: this.port }, "plaintext gRPC gateway listening");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  address(): AddressInfo | string | null {
    return this.server.address();
  }

  private onStream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
    const path = headers[":path"];
    if (path !== BROADCAST_PATH) {
      if (!isApprovedProxyPath(path)) {
        const submissionLike = isPotentialTransactionSubmissionPath(path);
        logger.warn(
          {
            path,
            remoteAddress: stream.session?.socket.remoteAddress ?? null,
            grpcStatus: submissionLike ? 7 : 12
          },
          submissionLike
            ? "blocked unrecognized transaction submission gRPC method"
            : "blocked unapproved gRPC method"
        );
        this.rejectGrpc(
          stream,
          submissionLike ? "7" : "12",
          submissionLike
            ? "Transaction submission method is not permitted"
            : "Method is not approved by the pinned java-tron API policy"
        );
        return;
      }
      this.upstream.proxyStream(stream, headers);
      return;
    }

    logger.info(
      { path, remoteAddress: stream.session?.socket.remoteAddress ?? null },
      "broadcast gRPC request received"
    );

    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > this.maxBroadcastBytes) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      if (exceeded) {
        this.send(
          stream,
          localResponse(ReturnCode.TOO_BIG_TRANSACTION_ERROR, "Broadcast request exceeds the configured size limit")
        );
        return;
      }
      void this.processor
        .handle(headers, Buffer.concat(chunks))
        .then((response) => this.send(stream, response))
        .catch((error) => {
          logger.error({ err: error }, "unhandled broadcast processor error");
          this.send(stream, localResponse(ReturnCode.SERVER_BUSY, "Gateway is temporarily unavailable"));
        });
    });
  }

  private send(stream: http2.ServerHttp2Stream, response: RawGrpcResponse): void {
    if (stream.destroyed) return;
    const headers = toOutgoingHeaders(response.headers);
    headers[":status"] ??= 200;
    headers["content-type"] ??= "application/grpc";
    const trailers = toOutgoingHeaders(response.trailers, true);
    trailers["grpc-status"] ??= "0";
    stream.respond(headers, { waitForTrailers: true });
    stream.on("wantTrailers", () => {
      if (!stream.destroyed) stream.sendTrailers(trailers);
    });
    stream.end(response.body);
  }

  private rejectGrpc(stream: http2.ServerHttp2Stream, status: string, message: string): void {
    if (stream.destroyed) return;
    stream.on("data", () => undefined);
    stream.on("end", () => {
      if (stream.destroyed) return;
      stream.respond({
        ":status": 200,
        "content-type": "application/grpc"
      }, { waitForTrailers: true });
      stream.on("wantTrailers", () => {
        if (!stream.destroyed) {
          stream.sendTrailers({
            "grpc-status": status,
            "grpc-message": message
          });
        }
      });
      stream.end();
    });
  }
}

function isPotentialTransactionSubmissionPath(path: string | undefined): boolean {
  if (!path) return false;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    // Do not proxy malformed escape sequences to an upstream whose path
    // normalization may differ from Node's HTTP/2 implementation.
    return true;
  }
  return /(?:broadcast|submit|relay|push)(?:transaction|trx|tx|hex)?/i.test(decodedPath);
}

function localResponse(code: number, message: string): RawGrpcResponse {
  return {
    headers: { ":status": 200, "content-type": "application/grpc" },
    body: encodeReturnFrame(false, code, message),
    trailers: { "grpc-status": "0" }
  };
}

function toOutgoingHeaders(
  input: Record<string, string | number | readonly string[]>,
  trailers = false
): http2.OutgoingHttpHeaders {
  const output: http2.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(input)) {
    if (trailers && name.startsWith(":")) continue;
    output[name] = typeof value === "object" ? Array.from(value) : value;
  }
  return output;
}
