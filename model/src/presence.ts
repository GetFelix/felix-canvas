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
}

/** Thrown by {@link decodePresence} when bytes are not a presence message. */
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
  });
}

/**
 * Decode a message written by {@link encodePresence}.
 *
 * @throws PresenceDecodeError if the bytes are not a presence message.
 */
export function decodePresence(bytes: Uint8Array): Presence {
  let value: unknown;
  try {
    value = decoder.decode(bytes);
  } catch (err) {
    throw new PresenceDecodeError(`not MessagePack: ${String(err)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PresenceDecodeError("presence is a map");
  }
  const { sid, n, name, color, x, y, sel, gone } = value as Record<string, unknown>;
  const sidValue = typeof sid === "number" && Number.isSafeInteger(sid) ? BigInt(sid) : sid;
  if (typeof sidValue !== "bigint" || sidValue < 0n || sidValue > MAX_U64) {
    throw new PresenceDecodeError("sid must be a u64");
  }
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
  };
}
