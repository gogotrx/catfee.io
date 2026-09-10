export type GrpcFrame = {
  compressed: boolean;
  payload: Buffer;
};

export function decodeUnaryGrpcFrame(body: Buffer): GrpcFrame {
  if (body.length < 5) {
    throw new Error("gRPC body is shorter than the five-byte frame header");
  }
  const flag = body[0];
  if (flag !== 0 && flag !== 1) {
    throw new Error(`Unsupported gRPC compression flag: ${flag}`);
  }
  const length = body.readUInt32BE(1);
  if (length !== body.length - 5) {
    throw new Error(`Expected one unary gRPC message of ${length} bytes, received ${body.length - 5}`);
  }
  return { compressed: flag === 1, payload: body.subarray(5) };
}

export function encodeUnaryGrpcFrame(payload: Uint8Array, compressed = false): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = compressed ? 1 : 0;
  frame.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(frame, 5);
  return frame;
}

export function extractLengthDelimitedField(message: Buffer, targetField: number): Buffer {
  let offset = 0;
  let found: Buffer | undefined;
  while (offset < message.length) {
    const tag = readVarint(message, offset);
    offset = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);

    if (wireType === 2) {
      const size = readVarint(message, offset);
      offset = size.nextOffset;
      const length = Number(size.value);
      const end = offset + length;
      if (!Number.isSafeInteger(length) || end > message.length) {
        throw new Error("Invalid protobuf length-delimited field");
      }
      if (fieldNumber === targetField) {
        if (found) throw new Error(`Protobuf field ${targetField} appears more than once`);
        found = message.subarray(offset, end);
      }
      offset = end;
      continue;
    }

    offset = skipWireValue(message, offset, wireType);
  }
  if (found) return found;
  throw new Error(`Protobuf field ${targetField} was not found`);
}

function readVarint(buffer: Buffer, start: number): { value: bigint; nextOffset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length && shift <= 63n) {
    const byte = buffer[offset];
    if (byte === undefined) break;
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) return { value, nextOffset: offset };
    shift += 7n;
  }
  throw new Error("Invalid protobuf varint");
}

function skipWireValue(buffer: Buffer, offset: number, wireType: number): number {
  if (wireType === 0) return readVarint(buffer, offset).nextOffset;
  if (wireType === 1) return checkedAdvance(buffer, offset, 8);
  if (wireType === 5) return checkedAdvance(buffer, offset, 4);
  throw new Error(`Unsupported protobuf wire type ${wireType}`);
}

function checkedAdvance(buffer: Buffer, offset: number, count: number): number {
  const next = offset + count;
  if (next > buffer.length) throw new Error("Truncated protobuf message");
  return next;
}
