import { describe, expect, it } from "vitest";
import { decodeUnaryGrpcFrame, encodeUnaryGrpcFrame, extractLengthDelimitedField } from "../src/grpc/framing.js";

describe("gRPC framing", () => {
  it("round trips one uncompressed unary message", () => {
    const payload = Buffer.from("hello");
    expect(decodeUnaryGrpcFrame(encodeUnaryGrpcFrame(payload))).toEqual({ compressed: false, payload });
  });

  it("rejects concatenated or truncated unary frames", () => {
    const frame = encodeUnaryGrpcFrame(Buffer.from("hello"));
    expect(() => decodeUnaryGrpcFrame(frame.subarray(0, -1))).toThrow(/Expected one unary/);
    expect(() => decodeUnaryGrpcFrame(Buffer.concat([frame, frame]))).toThrow(/Expected one unary/);
  });

  it("extracts a length-delimited protobuf field without re-encoding", () => {
    const message = Buffer.from([0x08, 0x01, 0x12, 0x03, 0xaa, 0xbb, 0xcc]);
    expect(extractLengthDelimitedField(message, 2)).toEqual(Buffer.from([0xaa, 0xbb, 0xcc]));
  });

  it("rejects duplicate singular fields", () => {
    const message = Buffer.from([0x0a, 0x01, 0xaa, 0x0a, 0x01, 0xbb]);
    expect(() => extractLengthDelimitedField(message, 1)).toThrow(/more than once/);
  });
});
