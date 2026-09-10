import * as http2 from "node:http2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BroadcastProcessor } from "../src/broadcast-processor.js";
import { BROADCAST_PATH } from "../src/domain.js";
import { GatewayServer } from "../src/grpc/gateway-server.js";
import { encodeReturnFrame } from "../src/grpc/protocol.js";
import { UpstreamGrpc } from "../src/grpc/upstream.js";

describe("gRPC gateway server", () => {
  const gateways: GatewayServer[] = [];
  const upstreams: UpstreamGrpc[] = [];
  const clients: http2.ClientHttp2Session[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
    for (const upstream of upstreams.splice(0)) upstream.close();
  });

  it("returns an application-level protobuf response with grpc-status trailer", async () => {
    const expected = encodeReturnFrame(false, 9, "busy");
    const processor = {
      async handle() {
        return {
          headers: { ":status": 200, "content-type": "application/grpc" },
          body: expected,
          trailers: { "grpc-status": "0" }
        };
      }
    } as unknown as BroadcastProcessor;
    const unusedUpstream = new UpstreamGrpc("http://127.0.0.1:1", 500);
    upstreams.push(unusedUpstream);
    const gateway = new GatewayServer("127.0.0.1", 0, 1024, processor, unusedUpstream);
    gateways.push(gateway);
    await gateway.listen();
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port");

    const client = http2.connect(`http://127.0.0.1:${address.port}`);
    clients.push(client);
    const stream = client.request({
      ":method": "POST",
      ":path": BROADCAST_PATH,
      "content-type": "application/grpc",
      te: "trailers"
    });
    const chunks: Buffer[] = [];
    let grpcStatus: string | string[] | undefined;
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("trailers", (trailers) => {
      grpcStatus = trailers["grpc-status"];
    });
    const ended = new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    stream.end(Buffer.from([0, 0, 0, 0, 0]));
    await ended;
    expect(Buffer.concat(chunks)).toEqual(expected);
    expect(grpcStatus).toBe("0");
  });

  it.each([
    ["/protocol.Wallet/BroadcastTransaction2", "7"],
    ["/protocol.Wallet/BroadcastTransaction?retry=true", "7"],
    ["/protocol.Wallet/%42roadcastTransaction", "7"],
    ["/protocol.Wallet/%ZZroadcastTransaction", "7"],
    ["/protocol.WalletSolidity/BroadcastTransaction", "7"],
    ["/custom.Relayer/SubmitTransaction", "7"],
    ["/custom.Relayer/RelayTx", "7"],
    ["/protocol.Wallet/EasyTransfer", "12"],
    ["/protocol.Wallet/SendRawTransaction", "12"],
    ["/protocol.Wallet/CommitTransaction", "12"],
    ["/protocol.Wallet/GetFutureData", "12"],
    ["/", "12"]
  ])("fails closed for an unapproved gRPC method: %s", async (path, expectedStatus) => {
    const processor = { handle: vi.fn() } as unknown as BroadcastProcessor;
    const upstream = { proxyStream: vi.fn() } as unknown as UpstreamGrpc;
    const gateway = new GatewayServer("127.0.0.1", 0, 1024, processor, upstream);
    gateways.push(gateway);
    await gateway.listen();
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port");

    const client = http2.connect(`http://127.0.0.1:${address.port}`);
    clients.push(client);
    const stream = client.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/grpc",
      te: "trailers"
    });
    let grpcStatus: string | string[] | undefined;
    stream.resume();
    stream.on("trailers", (trailers) => {
      grpcStatus = trailers["grpc-status"];
    });
    const ended = new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    stream.end(Buffer.from([0, 0, 0, 0, 0]));
    await ended;

    expect(grpcStatus).toBe(expectedStatus);
    expect(processor.handle).not.toHaveBeenCalled();
    expect(upstream.proxyStream).not.toHaveBeenCalled();
  });
});
