import { Encoder } from "@msgpack/msgpack";
import * as Y from "yjs";

import type { FieldValue, Op } from "./op.js";
import {
  TEXT_SHAPES,
  TextBody,
  applyTextUpdate,
  isBlank,
  isTextUpdate,
  newBodyDoc,
  pendingText,
} from "./text.js";
import { isZKey } from "./zorder.js";

/** The kinds of shape a `create` may name in its `type` field. */
export const SHAPE_TYPES = ["rect", "ellipse", "line", "stroke", "text"] as const;
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
  /** The rich text of the shapes that have any, by shape id. */
  readonly texts: ReadonlyMap<bigint, TextBody>;
}

/** The document before any op. */
export const EMPTY_DOC: Doc = { shapes: new Map(), seqs: new Map(), texts: new Map() };

// A shape's type never changes, and a finished stroke's points are final, so
// two people can never conflict over either.
const IMMUTABLE = new Set(["type", "points"]);

/**
 * Apply `op`, found at log `offset`, to `doc`. Each field is last-writer-wins
 * on offset. A patch to a shape that does not exist is ignored, which makes a
 * delete final, and so is a create of a shape that already does. A `text` op
 * merges its Yjs update into the shape's body, which a delete removes.
 *
 * An op whose `seq` is at or below the session's highest applied `seq` is a
 * repeat and changes nothing. That holds because one session's ops reach the
 * log in `seq` order: the gateway publishes a connection's ops one at a time,
 * and a session's seqs come from a counter that only grows.
 */
export function apply(doc: Doc, op: Op, offset: number): Doc {
  if (isRepeat(doc, op)) return doc;
  const seqs = new Map(doc.seqs).set(op.sid, op.seq);
  if (op.kind === "text") {
    const update = textUpdate(doc.shapes, op);
    if (!update) return { ...doc, seqs };
    const body = doc.texts.get(op.shape);
    const ydoc = body ? body.editable() : newBodyDoc();
    applyTextUpdate(ydoc, update);
    const texts = new Map(doc.texts).set(op.shape, TextBody.fromDoc(ydoc));
    return { shapes: doc.shapes, seqs, texts };
  }
  const change = shapeChange(doc.shapes, op, offset);
  if (!change) return { ...doc, seqs };
  let texts = doc.texts;
  if (!change[1] && texts.has(op.shape)) {
    const remaining = new Map(texts);
    remaining.delete(op.shape);
    texts = remaining;
  }
  return { shapes: setShape(new Map(doc.shapes), change), seqs, texts };
}

/** A document whose maps {@link applyInPlace} may change. */
export interface DraftDoc {
  shapes: Map<bigint, ShapeState>;
  seqs: Map<bigint, number>;
  /** Bodies as last frozen, or as live documents for those changed since. */
  bodies: Map<bigint, TextBody | Y.Doc>;
}

/**
 * Apply `op` as {@link apply} does, but by changing `doc`'s maps rather than
 * copying them, and bodies in their live documents. Copying a map per op
 * dominates a long fold, so a fold that keeps only its result uses this.
 * Shape states are replaced, never changed, and a frozen body is copied
 * before it changes, so a {@link freeze} taken earlier is unaffected.
 */
export function applyInPlace(doc: DraftDoc, op: Op, offset: number): void {
  if (isRepeat(doc, op)) return;
  doc.seqs.set(op.sid, op.seq);
  if (op.kind === "text") {
    const update = textUpdate(doc.shapes, op);
    if (!update) return;
    const body = doc.bodies.get(op.shape);
    const ydoc = body instanceof TextBody ? body.editable() : (body ?? newBodyDoc());
    applyTextUpdate(ydoc, update);
    doc.bodies.set(op.shape, ydoc);
    return;
  }
  const change = shapeChange(doc.shapes, op, offset);
  if (!change) return;
  setShape(doc.shapes, change);
  if (!change[1]) doc.bodies.delete(op.shape);
}

/** A copy of `doc` that {@link applyInPlace} can change. */
export function draft(doc: Doc): DraftDoc {
  return { shapes: new Map(doc.shapes), seqs: new Map(doc.seqs), bodies: new Map(doc.texts) };
}

/**
 * The document `doc` holds now. Only bodies changed since the last freeze
 * are frozen again; `doc` can go on changing without affecting the result.
 */
export function freeze(doc: DraftDoc): Doc {
  const texts = new Map<bigint, TextBody>();
  for (const [id, body] of doc.bodies) {
    const frozen = body instanceof TextBody ? body : TextBody.fromDoc(body);
    if (frozen !== body) doc.bodies.set(id, frozen);
    texts.set(id, frozen);
  }
  return { shapes: new Map(doc.shapes), seqs: new Map(doc.seqs), texts };
}

/**
 * The shapes whose bodies changed since the draft was last frozen and hold
 * updates waiting for others, with what each waits for (see {@link pendingText}).
 */
export function pendingBodies(doc: DraftDoc): Map<bigint, string> {
  const pending = new Map<bigint, string>();
  for (const [id, body] of doc.bodies) {
    const waiting = body instanceof Y.Doc ? pendingText(body) : null;
    if (waiting) pending.set(id, waiting);
  }
  return pending;
}

function isRepeat(doc: { seqs: ReadonlyMap<bigint, number> }, op: Op): boolean {
  const last = doc.seqs.get(op.sid);
  return last !== undefined && op.seq <= last;
}

/** The update a text op carries, if it applies: a well-formed one, on a shape that takes text. */
function textUpdate(shapes: ReadonlyMap<bigint, ShapeState>, op: Op): Uint8Array | null {
  const type = shapes.get(op.shape)?.fields.type;
  const update = op.fields.y;
  return typeof type === "string" && TEXT_SHAPES.includes(type) && isTextUpdate(update)
    ? update
    : null;
}

/** What `op` does to its shape: its new state, `null` for a delete, or nothing. */
type ShapeChange = [bigint, ShapeState | null] | null;

function setShape(shapes: Map<bigint, ShapeState>, [id, state]: [bigint, ShapeState | null]) {
  if (state) shapes.set(id, state);
  else shapes.delete(id);
  return shapes;
}

function shapeChange(shapes: ReadonlyMap<bigint, ShapeState>, op: Op, offset: number): ShapeChange {
  const shape = shapes.get(op.shape);
  switch (op.kind) {
    case "create": {
      if (shape || !SHAPE_TYPES.includes(op.fields.type as ShapeType)) return null;
      const fields: Record<string, FieldValue> = {};
      const written: Record<string, number> = {};
      for (const [name, value] of Object.entries(op.fields)) {
        if (!validField(name, value)) continue;
        fields[name] = value;
        written[name] = offset;
      }
      return [op.shape, { fields, written }];
    }
    case "patch": {
      if (!shape) return null;
      let next: { fields: Record<string, FieldValue>; written: Record<string, number> } | undefined;
      for (const [name, value] of Object.entries(op.fields)) {
        if (IMMUTABLE.has(name) || !validField(name, value)) continue;
        if ((shape.written[name] ?? -1) >= offset) continue;
        next ??= { fields: { ...shape.fields }, written: { ...shape.written } };
        next.fields[name] = value;
        next.written[name] = offset;
      }
      return next ? [op.shape, next] : null;
    }
    case "delete":
      return shape ? [op.shape, null] : null;
    case "text":
      return null;
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
 * A 64-bit hash of the shapes, their field values and what their text shows,
 * as 16 hex digits. Two replicas that applied the same log prefix hash the
 * same; offsets, dedupe bookkeeping and Yjs bytes are left out, so it
 * compares pictures, not histories.
 */
export function stateHash(doc: Doc): string {
  const shapes: Record<string, Readonly<Record<string, FieldValue>>> = {};
  for (const [id, shape] of doc.shapes) {
    const content = doc.texts.get(id)?.content;
    shapes[id.toString(16)] =
      content && !isBlank(content)
        ? { ...shape.fields, body: content as unknown as FieldValue }
        : shape.fields;
  }
  let hash = 0xcbf29ce484222325n;
  for (const byte of canonical.encode(shapes)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
