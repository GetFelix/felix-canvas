import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";

import {
  MAX_U128,
  MAX_U32,
  MAX_U64,
  OpDecodeError,
  decodeOp,
  encodeOp,
  randomSessionId,
  randomShapeId,
  type Op,
} from "../src/index.js";

const move: Op = {
  sid: 0x1234_5678_9abc_def0n,
  seq: 41,
  shape: 0x0123_4567_89ab_cdef_0123_4567_89ab_cdefn,
  kind: "patch",
  fields: { x: 120.5, y: -48.25 },
};

describe("encodeOp and decodeOp", () => {
  it("round-trip every kind", () => {
    const ops: Op[] = [
      {
        ...move,
        kind: "create",
        fields: { type: "rect", x: 0, y: 0, w: 10, h: 20, label: "hi", hidden: false },
      },
      move,
      { ...move, kind: "delete", fields: {} },
      { ...move, kind: "text", fields: { y: new Uint8Array([0, 1, 2]) } },
    ];
    expect(encodeOp(ops[3]!)).toContain(3);
    for (const op of ops) {
      expect(decodeOp(encodeOp(op))).toEqual(op);
    }
  });

  it("round-trip the edges of each integer range", () => {
    for (const [sid, seq, shape] of [
      [0n, 0, 0n],
      [MAX_U64, MAX_U32, MAX_U128],
    ] as const) {
      const op: Op = { ...move, sid, seq, shape };
      expect(decodeOp(encodeOp(op))).toEqual(op);
    }
  });

  it("keep nested and binary field values", () => {
    const op: Op = {
      ...move,
      kind: "create",
      fields: { points: [1, 2, 3, 4], style: { stroke: "#000" }, image: new Uint8Array([1, 2]) },
    };
    expect(decodeOp(encodeOp(op))).toEqual(op);
  });

  it("fit a typical move in the design's 60 to 120 bytes", () => {
    const size = encodeOp({ ...move, at: Date.now() }).length;
    expect(size).toBeGreaterThanOrEqual(60);
    expect(size).toBeLessThanOrEqual(120);
  });

  it("carry the time an op was made when it has one", () => {
    const at = Date.UTC(2026, 9, 2, 14, 3);
    expect(decodeOp(encodeOp({ ...move, at }))).toEqual({ ...move, at });
    expect(decodeOp(encodeOp(move))).not.toHaveProperty("at");
    expect(() => encodeOp({ ...move, at: -1 })).toThrow(RangeError);
    const bytes = encode({
      sid: 7,
      seq: 1,
      shape: new Uint8Array(16),
      kind: 1,
      fields: {},
      at: "x",
    });
    expect(decodeOp(bytes)).not.toHaveProperty("at");
  });

  it("accept a sid written as the smallest integer that fits", () => {
    const bytes = encode({ sid: 7, seq: 1, shape: new Uint8Array(16), kind: 1, fields: {} });
    expect(decodeOp(bytes).sid).toBe(7n);
  });

  it("refuse ids and seq outside their ranges", () => {
    expect(() => encodeOp({ ...move, sid: -1n })).toThrow(RangeError);
    expect(() => encodeOp({ ...move, sid: MAX_U64 + 1n })).toThrow(RangeError);
    expect(() => encodeOp({ ...move, shape: MAX_U128 + 1n })).toThrow(RangeError);
    expect(() => encodeOp({ ...move, seq: MAX_U32 + 1 })).toThrow(RangeError);
    expect(() => encodeOp({ ...move, seq: 1.5 })).toThrow(RangeError);
  });

  it("reject bytes that are not an op", () => {
    const valid = { sid: 1, seq: 1, shape: new Uint8Array(16), kind: 0, fields: {} };
    const malformed = [
      new Uint8Array([0xc1]),
      encode([1, 2, 3]),
      encode({ ...valid, kind: 4 }),
      encode({ ...valid, kind: "patch" }),
      encode({ ...valid, shape: new Uint8Array(15) }),
      encode({ ...valid, seq: -1 }),
      encode({ ...valid, sid: "1" }),
      encode({ ...valid, fields: [] }),
    ];
    for (const bytes of malformed) {
      expect(() => decodeOp(bytes)).toThrow(OpDecodeError);
    }
  });
});

describe("random ids", () => {
  it("stay in range and differ", () => {
    const sids = new Set(Array.from({ length: 64 }, randomSessionId));
    const shapes = new Set(Array.from({ length: 64 }, randomShapeId));
    expect(sids.size).toBe(64);
    expect(shapes.size).toBe(64);
    for (const sid of sids) expect(sid <= MAX_U64).toBe(true);
    for (const shape of shapes) expect(shape <= MAX_U128).toBe(true);
  });
});
