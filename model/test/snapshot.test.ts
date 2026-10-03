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

const ana = 0xaaaan;
const ben = 0xffff_ffff_ffff_fff0n;

function log(): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < 40; i++) {
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
  return ops;
}

const fold = (ops: Op[], doc: Doc = EMPTY_DOC, first = 0): Doc =>
  ops.reduce((state, op, i) => apply(state, op, first + i), doc);

describe("snapshots", () => {
  it("round-trip shapes, the offsets that wrote them, and seqs", () => {
    const doc = fold(log());
    const { doc: back, offset } = decodeSnapshot(encodeSnapshot({ doc, offset: 39 }));
    expect(offset).toBe(39);
    expect(back.shapes).toEqual(doc.shapes);
    expect(back.seqs).toEqual(doc.seqs);
  });

  it("plus the rest of the log give the same state as folding it all", () => {
    const ops = log();
    const whole = fold(ops);
    for (const cut of [0, 1, 7, 20, 39]) {
      const snapshot = decodeSnapshot(
        encodeSnapshot({ doc: fold(ops.slice(0, cut + 1)), offset: cut }),
      );
      const resumed = fold(ops.slice(cut + 1), snapshot.doc, cut + 1);
      expect(stateHash(resumed)).toBe(stateHash(whole));
    }
  });

  it("still recognise a retried op that lands after them", () => {
    const ops = log();
    const snapshot = decodeSnapshot(encodeSnapshot({ doc: fold(ops), offset: 39 }));
    const retried = apply(snapshot.doc, ops[30]!, 40);
    expect(retried).toBe(snapshot.doc);
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
