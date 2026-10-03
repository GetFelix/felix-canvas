import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";

import {
  EMPTY_DOC,
  SnapshotDecodeError,
  apply,
  decodeSnapshot,
  encodeSnapshot,
  stateHash,
  type Doc,
  type Op,
} from "../src/index.js";
import { Author, block, firstText } from "./authors.js";

const ana = 0xaaaan;
const ben = 0xffff_ffff_ffff_fff0n;

/** Strokes moved and deleted, then two rectangles typed into. */
function log(): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < 30; i++) {
    const sid = i % 2 ? ana : ben;
    const seq = Math.floor(i / 2);
    const shape = BigInt(1 + (i % 7));
    ops.push(
      i < 7
        ? {
            sid,
            seq,
            shape,
            kind: "create",
            fields: { type: "stroke", x: i, y: 0, w: 5, h: 5, z: "V", points: [0, 0, 5, 5] },
          }
        : i % 11 === 0
          ? { sid, seq, shape, kind: "delete", fields: {} }
          : { sid, seq, shape, kind: "patch", fields: { x: i * 3, y: -i } },
    );
  }
  const typist = new Author(0xc1e0n);
  for (const shape of [100n, 101n]) {
    const fields = { type: "rect", x: 0, y: 0, w: 50, h: 50, z: "W" };
    ops.push({ sid: typist.sid, seq: typist.seq++, shape, kind: "create", fields });
    ops.push(typist.edit(shape, (body) => body.insert(0, [block("text in a box")])));
  }
  for (let i = 0; i < 6; i++) {
    typist.catchUp(ops);
    ops.push(typist.edit(100n + BigInt(i % 2), (body) => firstText(body).insert(i, `${i}`)));
  }
  return ops;
}

const fold = (ops: Op[], doc: Doc = EMPTY_DOC, first = 0): Doc =>
  ops.reduce((state, op, i) => apply(state, op, first + i), doc);

describe("snapshots", () => {
  it("round-trip shapes, the offsets that wrote them, seqs and text", () => {
    const ops = log();
    const doc = fold(ops);
    const last = ops.length - 1;
    const { doc: back, offset } = decodeSnapshot(encodeSnapshot({ doc, offset: last }));
    expect(offset).toBe(last);
    expect(back.shapes).toEqual(doc.shapes);
    expect(back.seqs).toEqual(doc.seqs);
    expect([...back.texts.keys()]).toEqual([100n, 101n]);
    expect(stateHash(back)).toBe(stateHash(doc));
  });

  it("of the first version, which had no text, still decode", () => {
    const shape = [new Uint8Array(16), { type: "rect" }, { type: 3 }];
    const bytes = encode({ v: 1, offset: 3, shapes: [shape], seqs: [[5, 2]] });
    const { doc, offset } = decodeSnapshot(bytes);
    expect(offset).toBe(3);
    expect(doc.shapes.get(0n)?.fields).toEqual({ type: "rect" });
    expect(doc.texts.size).toBe(0);
  });

  it("plus the rest of the log give the same state as folding it all", () => {
    const ops = log();
    const whole = fold(ops);
    for (const cut of [0, 1, 7, 20, 31, 35, ops.length - 1]) {
      const snapshot = decodeSnapshot(
        encodeSnapshot({ doc: fold(ops.slice(0, cut + 1)), offset: cut }),
      );
      const resumed = fold(ops.slice(cut + 1), snapshot.doc, cut + 1);
      expect(stateHash(resumed)).toBe(stateHash(whole));
    }
  });

  it("still recognise a retried op that lands after them", () => {
    const ops = log();
    const snapshot = decodeSnapshot(encodeSnapshot({ doc: fold(ops), offset: ops.length - 1 }));
    for (const op of [ops[20]!, ops.at(-2)!]) {
      expect(apply(snapshot.doc, op, ops.length)).toBe(snapshot.doc);
    }
  });

  it("refuse bytes that are not a snapshot", () => {
    for (const bytes of [
      new Uint8Array([0xc1]),
      encodeSnapshot({ doc: EMPTY_DOC, offset: 0 }).slice(1),
    ]) {
      expect(() => decodeSnapshot(bytes)).toThrow(SnapshotDecodeError);
    }
  });
});
