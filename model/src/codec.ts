import { Decoder, Encoder } from "@msgpack/msgpack";

import { MAX_U32, MAX_U64, MAX_U128, type FieldValue, type Op, type OpKind } from "./op.js";

/** Thrown by {@link decodeOp} when bytes are not a well-formed op. */
export class OpDecodeError extends Error {
  override name = "OpDecodeError";
}

// Kinds go on the wire as small integers: most ops are patches, and the name
// would cost more than the rest of a typical move's header.
const KINDS: readonly OpKind[] = ["create", "patch", "delete"];

const encoder = new Encoder({ useBigInt64: true });
const decoder = new Decoder({ useBigInt64: true });

/**
 * Encode an op as a MessagePack map of `sid`, `seq`, `shape`, `kind` and
 * `fields`. `shape` is 16 bytes, big-endian, since MessagePack has no u128.
 *
 * @throws RangeError if an id or `seq` is outside its integer range.
 */
export function encodeOp(op: Op): Uint8Array {
  checkRange("sid", op.sid, MAX_U64);
  checkRange("shape", op.shape, MAX_U128);
  if (!Number.isInteger(op.seq) || op.seq < 0 || op.seq > MAX_U32) {
    throw new RangeError(`seq ${op.seq} is not a u32`);
  }
  return encoder.encode({
    sid: op.sid,
    seq: op.seq,
    shape: u128ToBytes(op.shape),
    kind: KINDS.indexOf(op.kind),
    fields: op.fields,
  });
}

/**
 * Decode an op written by {@link encodeOp}, or by any encoder that writes
 * `sid` and `seq` as the smallest integer that fits.
 *
 * @throws OpDecodeError if the bytes are not MessagePack or not an op.
 */
export function decodeOp(bytes: Uint8Array): Op {
  let value: unknown;
  try {
    value = decoder.decode(bytes);
  } catch (err) {
    throw new OpDecodeError(`not MessagePack: ${String(err)}`);
  }
  if (!isRecord(value)) {
    throw new OpDecodeError("an op is a map");
  }
  const { sid, seq, shape, kind, fields } = value;
  const kindName = typeof kind === "number" ? KINDS[kind] : undefined;
  if (kindName === undefined) {
    throw new OpDecodeError(`unknown kind ${String(kind)}`);
  }
  if (!(shape instanceof Uint8Array) || shape.length !== 16) {
    throw new OpDecodeError("shape must be 16 bytes");
  }
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > MAX_U32) {
    throw new OpDecodeError("seq must be a u32");
  }
  if (!isRecord(fields)) {
    throw new OpDecodeError("fields must be a map");
  }
  return {
    sid: toU64(sid),
    seq,
    shape: bytesToU128(shape),
    kind: kindName,
    fields: fields as Record<string, FieldValue>,
  };
}

function toU64(value: unknown): bigint {
  const sid =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : undefined;
  if (sid === undefined || sid < 0n || sid > MAX_U64) {
    throw new OpDecodeError("sid must be a u64");
  }
  return sid;
}

function checkRange(name: string, value: bigint, max: bigint): void {
  if (value < 0n || value > max) {
    throw new RangeError(`${name} ${value} is out of range`);
  }
}

function u128ToBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function bytesToU128(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}
