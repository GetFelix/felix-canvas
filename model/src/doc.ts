import { Encoder } from "@msgpack/msgpack";

import type { FieldValue, Op } from "./op.js";
import { isZKey } from "./zorder.js";

/** The kinds of shape a `create` may name in its `type` field. */
export const SHAPE_TYPES = ["rect", "ellipse", "line", "stroke"] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

/** One shape: its fields, and the log offset that last wrote each one. */
export interface ShapeState {
  readonly fields: Readonly<Record<string, FieldValue>>;
  readonly written: Readonly<Record<string, number>>;
}

/**
 * A room's state after some prefix of its op log. Treat it as immutable:
 * {@link apply} returns a new document and shares what did not change.
 */
export interface Doc {
  readonly shapes: ReadonlyMap<bigint, ShapeState>;
  /** The highest `seq` applied for each session. */
  readonly seqs: ReadonlyMap<bigint, number>;
}

/** The document before any op. */
export const EMPTY_DOC: Doc = { shapes: new Map(), seqs: new Map() };

// A shape's type never changes, and a finished stroke's points are final, so
// two people can never conflict over either.
const IMMUTABLE = new Set(["type", "points"]);

/**
 * Apply `op`, found at log `offset`, to `doc`. Each field is last-writer-wins
 * on offset. A patch to a shape that does not exist is ignored, which makes a
 * delete final, and so is a create of a shape that already does.
 *
 * An op whose `seq` is at or below the session's highest applied `seq` is a
 * repeat and changes nothing. That holds because one session's ops reach the
 * log in `seq` order: the gateway publishes a connection's ops one at a time,
 * and a session's seqs come from a counter that only grows.
 */
export function apply(doc: Doc, op: Op, offset: number): Doc {
  const last = doc.seqs.get(op.sid);
  if (last !== undefined && op.seq <= last) return doc;
  const seqs = new Map(doc.seqs).set(op.sid, op.seq);
  return { shapes: applyToShapes(doc.shapes, op, offset), seqs };
}

function applyToShapes(
  shapes: ReadonlyMap<bigint, ShapeState>,
  op: Op,
  offset: number,
): ReadonlyMap<bigint, ShapeState> {
  const shape = shapes.get(op.shape);
  switch (op.kind) {
    case "create": {
      if (shape || !SHAPE_TYPES.includes(op.fields.type as ShapeType)) return shapes;
      const fields: Record<string, FieldValue> = {};
      const written: Record<string, number> = {};
      for (const [name, value] of Object.entries(op.fields)) {
        if (!validField(name, value)) continue;
        fields[name] = value;
        written[name] = offset;
      }
      return new Map(shapes).set(op.shape, { fields, written });
    }
    case "patch": {
      if (!shape) return shapes;
      let next: { fields: Record<string, FieldValue>; written: Record<string, number> } | undefined;
      for (const [name, value] of Object.entries(op.fields)) {
        if (IMMUTABLE.has(name) || !validField(name, value)) continue;
        if ((shape.written[name] ?? -1) >= offset) continue;
        next ??= { fields: { ...shape.fields }, written: { ...shape.written } };
        next.fields[name] = value;
        next.written[name] = offset;
      }
      return next ? new Map(shapes).set(op.shape, next) : shapes;
    }
    case "delete": {
      if (!shape) return shapes;
      const without = new Map(shapes);
      without.delete(op.shape);
      return without;
    }
  }
}

function validField(name: string, value: FieldValue): boolean {
  return name !== "z" || isZKey(value);
}

/** Shapes from bottom to top: by z key, then by id when two keys tie. */
export function inZOrder(doc: Doc): [bigint, ShapeState][] {
  return [...doc.shapes].sort(([a, sa], [b, sb]) => {
    const za = String(sa.fields.z ?? "");
    const zb = String(sb.fields.z ?? "");
    if (za !== zb) return za < zb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

const canonical = new Encoder({ sortKeys: true, useBigInt64: true });

/**
 * A 64-bit hash of the shapes and their field values, as 16 hex digits. Two
 * replicas that applied the same log prefix hash the same; offsets and
 * dedupe bookkeeping are left out, so it compares pictures, not histories.
 */
export function stateHash(doc: Doc): string {
  const shapes: Record<string, Readonly<Record<string, FieldValue>>> = {};
  for (const [id, shape] of doc.shapes) shapes[id.toString(16)] = shape.fields;
  let hash = 0xcbf29ce484222325n;
  for (const byte of canonical.encode(shapes)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
