import * as http2 from "node:http2";
import { afterEach, describe, expect, it } from "vitest";
import { UpstreamGrpc } from "../src/grpc/upstream.js";

describe("raw gRPC upstream", () => {
  const servers: http2.Http2Server[] = [];
  const clients: UpstreamGrpc[] = [];

  afterEach(async () => {
    for (const client of clients) client.close();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("preserves unary bytes and gRPC trailers", async () => {
    const server = http2.createServer();
    servers.push(server);
    server.on("stream", (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0", "x-test-trailer": "ok" }));
        stream.end(Buffer.concat(chunks));
      });
      expect(headers[":path"]).toBe("/protocol.Wallet/GetNowBlock");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

    const upstream = new UpstreamGrpc(`http://127.0.0.1:${address.port}`, 2_000);
    clients.push(upstream);
    const body = Buffer.from([0, 0, 0, 0, 0]);
    const response = await upstream.unary(
      {
        ":method": "POST",
        ":path": "/protocol.Wallet/GetNowBlock",
        "content-type": "application/grpc",
        te: "trailers"
      },
      body
    );
    expect(response.body).toEqual(body);
    expect(response.trailers["grpc-status"]).toBe("0");
    expect(response.trailers["x-test-trailer"]).toBe("ok");
  });
});
