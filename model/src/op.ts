/** What an op does to its shape. */
export type OpKind = "create" | "patch" | "delete" | "text";

/** A shape field's value. Anything MessagePack carries without extensions. */
export type FieldValue =
  null | boolean | number | string | Uint8Array | FieldValue[] | { [key: string]: FieldValue };

/**
 * One edit to one shape, as published on `canvas.ops.<room>`.
 *
 * `(sid, seq)` identifies an op across retries, so a publish that lands twice
 * can be applied once.
 */
export interface Op {
  /** Session that authored the op, a u64. Used for dedupe and echo suppression. */
  sid: bigint;
  /** Per-session counter, a u32, increasing with every op the session sends. */
  seq: number;
  /** Target shape, a u128 chosen by the client that created it. */
  shape: bigint;
  kind: OpKind;
  /** Only the fields this op changes. Empty for a delete; for `text`, `y`, a Yjs update. */
  fields: Record<string, FieldValue>;
  /**
   * When the edit was made, in milliseconds since 1970 by the author's clock.
   * Only history shows it; the fold ignores it. Absent on older ops.
   */
  at?: number;
}

/** Largest value of a u64, the range of {@link Op.sid}. */
export const MAX_U64 = (1n << 64n) - 1n;
/** Largest value of a u128, the range of {@link Op.shape}. */
export const MAX_U128 = (1n << 128n) - 1n;
/** Largest value of a u32, the range of {@link Op.seq}. */
export const MAX_U32 = 0xffff_ffff;

/** A random session id, for a session that has just started. */
export function randomSessionId(): bigint {
  return randomBits(8);
}

/** A random shape id, for a shape this session is creating. */
export function randomShapeId(): bigint {
  return randomBits(16);
}

function randomBits(bytes: number): bigint {
  let value = 0n;
  for (const byte of crypto.getRandomValues(new Uint8Array(bytes))) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}
