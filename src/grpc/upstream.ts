import * as http2 from "node:http2";
import type { RawGrpcResponse } from "../domain.js";
import { logger } from "../logger.js";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

export class UpstreamGrpc {
  private session: http2.ClientHttp2Session | null = null;
  private readonly endpoint: URL;

  constructor(
    url: string,
    private readonly timeoutMs = 15_000,
    private readonly maxResponseBytes = 32 * 1024 * 1024
  ) {
    this.endpoint = new URL(url);
  }

  async unary(headers: http2.IncomingHttpHeaders, body: Buffer): Promise<RawGrpcResponse> {
    const request = this.getSession().request(this.requestHeaders(headers));
    return new Promise<RawGrpcResponse>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let responseHeaders: http2.IncomingHttpHeaders = {};
      let trailers: http2.IncomingHttpHeaders = {};

      request.on("response", (headersValue) => {
        responseHeaders = headersValue;
      });
      request.on("trailers", (trailersValue) => {
        trailers = trailersValue;
      });
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxResponseBytes) {
          request.close(http2.constants.NGHTTP2_CANCEL);
          reject(new Error("Upstream gRPC response exceeded the configured limit"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      request.on("end", () => {
        resolve({
          headers: normalizeHeaders(responseHeaders),
          body: Buffer.concat(chunks),
          trailers: normalizeHeaders(trailers)
        });
      });
      request.on("error", reject);
      request.setTimeout(this.timeoutMs, () => {
        request.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error("Upstream gRPC request timed out"));
      });
      request.end(body);
    });
  }

  proxyStream(downstream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
    let upstream: http2.ClientHttp2Stream;
    try {
      upstream = this.getSession().request(this.requestHeaders(headers));
    } catch (error) {
      this.failDownstream(downstream, error);
      return;
    }

    let trailers: http2.IncomingHttpHeaders = {};
    let responded = false;
    upstream.on("response", (responseHeaders) => {
      responded = true;
      downstream.respond(filterResponseHeaders(responseHeaders), { waitForTrailers: true });
    });
    upstream.on("trailers", (value) => {
      trailers = value;
    });
    downstream.on("wantTrailers", () => {
      if (!downstream.destroyed) downstream.sendTrailers(filterTrailers(trailers));
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!downstream.write(chunk)) upstream.pause();
    });
    downstream.on("drain", () => upstream.resume());
    upstream.on("end", () => {
      if (!responded && !downstream.destroyed) {
        downstream.respond({ ":status": 502, "content-type": "application/grpc" }, { waitForTrailers: true });
      }
      if (!downstream.destroyed) downstream.end();
    });
    upstream.on("error", (error) => this.failDownstream(downstream, error));
    upstream.setTimeout(this.timeoutMs, () => {
      upstream.close(http2.constants.NGHTTP2_CANCEL);
      this.failDownstream(downstream, new Error("Upstream gRPC stream timed out"));
    });

    downstream.on("data", (chunk: Buffer) => {
      if (!upstream.write(chunk)) downstream.pause();
    });
    upstream.on("drain", () => downstream.resume());
    downstream.on("end", () => upstream.end());
    downstream.on("aborted", () => upstream.close(http2.constants.NGHTTP2_CANCEL));
    downstream.on("error", () => upstream.close(http2.constants.NGHTTP2_CANCEL));
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }

  private getSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = http2.connect(this.endpoint.origin);
    session.on("error", (error) => logger.error({ err: error }, "upstream gRPC session error"));
    session.on("close", () => {
      if (this.session === session) this.session = null;
    });
    this.session = session;
    return session;
  }

  private requestHeaders(headers: http2.IncomingHttpHeaders): http2.OutgoingHttpHeaders {
    const output: http2.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
      if (name === ":authority" || name === "host") continue;
      output[name] = value;
    }
    output[":authority"] = this.endpoint.host;
    return output;
  }

  private failDownstream(stream: http2.ServerHttp2Stream, error: unknown): void {
    logger.error({ err: error }, "upstream gRPC proxy failed");
    if (stream.destroyed) return;
    try {
      if (stream.headersSent) {
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      } else {
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "14" });
        stream.end();
      }
    } catch {
      stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    }
  }
}

function normalizeHeaders(headers: http2.IncomingHttpHeaders): Record<string, string | number | readonly string[]> {
  const output: Record<string, string | number | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function filterResponseHeaders(headers: http2.IncomingHttpHeaders): http2.OutgoingHttpHeaders {
  const output: http2.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    output[name] = value;
  }
  output[":status"] ??= 200;
  return output;
}

function filterTrailers(headers: http2.IncomingHttpHeaders): http2.OutgoingHttpHeaders {
  const output: http2.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    output[name] = value;
  }
  output["grpc-status"] ??= "0";
  return output;
}
