import { Decoder, Encoder } from "@msgpack/msgpack";

import { bytesToU128, u128ToBytes } from "./codec.js";
import type { Doc, ShapeState } from "./doc.js";
import type { FieldValue } from "./op.js";
import { TextBody } from "./text.js";

/**
 * A room's state after its log up to and including `offset`, as stored in
 * `canvas.snap/<room>`. Keeping the offset in the same value is what lets a
 * reader know exactly where in the log to continue.
 */
export interface Snapshot {
  doc: Doc;
  /** The last log offset folded into `doc`. */
  offset: number;
}

/** Thrown by {@link decodeSnapshot} when bytes are not a snapshot. */
export class SnapshotDecodeError extends Error {
  override name = "SnapshotDecodeError";
}

const VERSION = 2;
const encoder = new Encoder({ useBigInt64: true });
const decoder = new Decoder({ useBigInt64: true });

/**
 * Encode a snapshot as a MessagePack map: `v`, `offset`, `shapes` as
 * `[id, fields, written]` triples, `seqs` as `[sid, seq]` pairs and `texts`
 * as `[id, state]` pairs. The seqs travel with the shapes so a retried op
 * landing after the snapshot is still recognised as a repeat.
 */
export function encodeSnapshot({ doc, offset }: Snapshot): Uint8Array {
  return encoder.encode({
    v: VERSION,
    offset,
    shapes: [...doc.shapes].map(([id, shape]) => [u128ToBytes(id), shape.fields, shape.written]),
    seqs: [...doc.seqs],
    texts: [...doc.texts].map(([id, body]) => [u128ToBytes(id), body.state]),
  });
}

/**
 * Decode a snapshot written by {@link encodeSnapshot}, or by the first
 * version, which had no text.
 *
 * @throws SnapshotDecodeError if the bytes are not a snapshot of a known version.
 */
export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  let value: unknown;
  try {
    value = decoder.decode(bytes);
  } catch (err) {
    throw new SnapshotDecodeError(`not MessagePack: ${String(err)}`);
  }
  const { v, offset, shapes, seqs, texts = [] } = (value ?? {}) as Record<string, unknown>;
  if (v !== 1 && v !== VERSION)
    throw new SnapshotDecodeError(`unknown snapshot version ${String(v)}`);
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new SnapshotDecodeError("offset must be a log offset");
  }
  if (!Array.isArray(shapes) || !Array.isArray(seqs) || !Array.isArray(texts)) {
    throw new SnapshotDecodeError("shapes, seqs and texts must be lists");
  }
  const shapeMap = new Map<bigint, ShapeState>();
  for (const entry of shapes) {
    const [id, fields, written] = Array.isArray(entry) ? entry : [];
    if (!(id instanceof Uint8Array) || id.length !== 16 || !isMap(fields) || !isMap(written)) {
      throw new SnapshotDecodeError("a shape is [id, fields, written]");
    }
    shapeMap.set(bytesToU128(id), {
      fields: fields as Record<string, FieldValue>,
      written: written as Record<string, number>,
    });
  }
  const seqMap = new Map<bigint, number>();
  for (const entry of seqs) {
    const [sid, seq] = Array.isArray(entry) ? entry : [];
    const id = typeof sid === "number" ? BigInt(sid) : sid;
    if (typeof id !== "bigint" || typeof seq !== "number") {
      throw new SnapshotDecodeError("a seq entry is [sid, seq]");
    }
    seqMap.set(id, seq);
  }
  const textMap = new Map<bigint, TextBody>();
  for (const entry of texts) {
    const [id, state] = Array.isArray(entry) ? entry : [];
    if (!(id instanceof Uint8Array) || id.length !== 16 || !(state instanceof Uint8Array)) {
      throw new SnapshotDecodeError("a text is [id, state]");
    }
    textMap.set(bytesToU128(id), TextBody.fromState(state));
  }
  return { doc: { shapes: shapeMap, seqs: seqMap, texts: textMap }, offset };
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
