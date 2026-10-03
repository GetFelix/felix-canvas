import { Decoder, Encoder } from "@msgpack/msgpack";

import { bytesToU128, u128ToBytes } from "./codec.js";
import { MAX_U32, MAX_U64 } from "./op.js";

/**
 * One session's cursor and selection, as published on
 * `canvas.presence.<room>`. Each message replaces the last one from its
 * session; nothing on this stream is kept.
 */
export interface Presence {
  sid: bigint;
  /** Increases with every message from the session, so it can time its own echo. */
  n: number;
  name: string;
  /** Index into the eight-colour presence palette. */
  color: number;
  /** Pointer position in canvas coordinates, or `null` when it left the canvas. */
  cursor: { x: number; y: number } | null;
  /** Ids of the shapes the session has selected. */
  selection: bigint[];
  /** Set on the last message of a session that is closing. */
  gone?: boolean;
  /**
   * How many changes the session has applied: its next log offset. A viewer
   * that has fewer for long has lost its newest changes.
   */
  applied?: number;
}

/**
 * A session's entry in the room's member list, the cache key
 * `canvas.presence/<room>:<session>`. It expires unless rewritten, so a
 * session that vanishes drops out on its own.
 */
export interface Member {
  name: string;
  /** Index into the eight-colour presence palette. */
  color: number;
  /**
   * A u64 kept by the browser across visits, unlike the session id, so one
   * person keeps one colour and shows once however many tabs they open.
   */
  person: bigint;
}

/** Thrown when bytes are not a presence message or member entry. */
export class PresenceDecodeError extends Error {
  override name = "PresenceDecodeError";
}

const encoder = new Encoder({ useBigInt64: true });
const decoder = new Decoder({ useBigInt64: true });

/** Encode a presence message as a MessagePack map. */
export function encodePresence(presence: Presence): Uint8Array {
  return encoder.encode({
    sid: presence.sid,
    n: presence.n,
    name: presence.name,
    color: presence.color,
    x: presence.cursor?.x ?? null,
    y: presence.cursor?.y ?? null,
    sel: presence.selection.map(u128ToBytes),
    ...(presence.gone ? { gone: true } : {}),
    ...(presence.applied !== undefined ? { at: presence.applied } : {}),
  });
}

/** Encode a member entry as a MessagePack map. */
export function encodeMember(member: Member): Uint8Array {
  return encoder.encode({ name: member.name, color: member.color, person: member.person });
}

/**
 * Decode an entry written by {@link encodeMember}.
 *
 * @throws PresenceDecodeError if the bytes are not a member entry.
 */
export function decodeMember(bytes: Uint8Array): Member {
  const { name, color, person } = decodeMap(bytes);
  if (typeof name !== "string" || typeof color !== "number") {
    throw new PresenceDecodeError("name and color are required");
  }
  return { name, color, person: u64(person, "person") };
}

/**
 * Decode a message written by {@link encodePresence}.
 *
 * @throws PresenceDecodeError if the bytes are not a presence message.
 */
export function decodePresence(bytes: Uint8Array): Presence {
  const { sid, n, name, color, x, y, sel, gone, at } = decodeMap(bytes);
  const sidValue = u64(sid, "sid");
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_U32) {
    throw new PresenceDecodeError("n must be a u32");
  }
  if (typeof name !== "string" || typeof color !== "number") {
    throw new PresenceDecodeError("name and color are required");
  }
  const cursor = typeof x === "number" && typeof y === "number" ? { x, y } : null;
  if (!Array.isArray(sel) || !sel.every((id) => id instanceof Uint8Array && id.length === 16)) {
    throw new PresenceDecodeError("sel must be a list of shape ids");
  }
  return {
    sid: sidValue,
    n,
    name,
    color,
    cursor,
    selection: sel.map(bytesToU128),
    ...(gone === true ? { gone: true } : {}),
    ...(Number.isSafeInteger(at) && (at as number) >= 0 ? { applied: at as number } : {}),
  };
}

function decodeMap(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = decoder.decode(bytes);
  } catch (err) {
    throw new PresenceDecodeError(`not MessagePack: ${String(err)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PresenceDecodeError("expected a map");
  }
  return value as Record<string, unknown>;
}

// MessagePack hands back small integers as numbers and large ones as bigints.
function u64(value: unknown, field: string): bigint {
  const big = typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof big !== "bigint" || big < 0n || big > MAX_U64) {
    throw new PresenceDecodeError(`${field} must be a u64`);
  }
  return big;
}
