import { describe, expect, it } from "vitest";

import { EMPTY_DOC, apply, inZOrder, stateHash, type Doc, type Op } from "../src/index.js";

const ana = 0xaaaan;
const ben = 0xbbbbn;
const box = 0x1234n;

const create = (sid: bigint, seq: number, shape = box, fields = {}): Op => ({
  sid,
  seq,
  shape,
  kind: "create",
  fields: { type: "rect", x: 0, y: 0, w: 10, h: 10, z: "V", ...fields },
});
const patch = (sid: bigint, seq: number, fields: Op["fields"], shape = box): Op => ({
  sid,
  seq,
  shape,
  kind: "patch",
  fields,
});

/** Fold `log`, whose ops sit at offsets 0, 1, 2, ... */
function fold(log: Op[], doc: Doc = EMPTY_DOC, first = 0): Doc {
  return log.reduce((state, op, i) => apply(state, op, first + i), doc);
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("apply", () => {
  it("resolves concurrent writes to one field to the higher offset", () => {
    // Both sessions saw the create and moved the box without seeing each other.
    for (const [first, second, winner] of [
      [ana, ben, 7],
      [ben, ana, 7],
    ] as const) {
      const log = [create(ana, 0), patch(first, 1, { x: 3 }), patch(second, 1, { x: 7 })];
      const doc = fold(log);
      expect(doc.shapes.get(box)?.fields.x).toBe(winner);
      expect(doc.shapes.get(box)?.written.x).toBe(2);
    }
  });

  it("keeps concurrent writes to different fields of one shape", () => {
    const doc = fold([create(ana, 0), patch(ana, 1, { x: 40 }), patch(ben, 0, { w: 90 })]);
    expect(doc.shapes.get(box)?.fields).toMatchObject({ x: 40, w: 90, y: 0, h: 10 });
  });

  it("converges whatever order patches with known offsets arrive in", () => {
    const sessions = [ana, ben, 0xccccn];
    const patches: [Op, number][] = [];
    for (let offset = 1; offset <= 60; offset++) {
      const sid = sessions[offset % 3]!;
      const field = ["x", "y", "w"][offset % 4 === 0 ? 2 : offset % 2]!;
      patches.push([patch(sid, offset, { [field]: offset * 3 }), offset]);
    }
    const base = apply(EMPTY_DOC, create(ana, 0), 0);
    const inOrder = patches.reduce((doc, [op, offset]) => apply(doc, op, offset), base);
    for (let seed = 1; seed <= 20; seed++) {
      // Dedupe assumes each session's ops arrive in seq order, so shuffle
      // the interleaving of sessions, not one session's own order.
      const bySession = sessions.map((sid) => patches.filter(([op]) => op.sid === sid));
      const order = shuffled(
        bySession.flatMap((ops, s) => ops.map(() => s)),
        seed,
      );
      const queues = bySession.map((ops) => [...ops]);
      const replica = order.reduce((doc, s) => {
        const [op, offset] = queues[s]!.shift()!;
        return apply(doc, op, offset);
      }, base);
      expect(stateHash(replica)).toBe(stateHash(inOrder));
    }
  });

  it("gives two replicas of one log prefix the same hash", () => {
    const log = [
      create(ana, 0),
      create(ben, 0, 0x99n, { type: "ellipse", z: "k" }),
      patch(ana, 1, { x: 5, y: 6 }),
      patch(ben, 1, { x: 9 }),
      patch(ben, 2, { z: "a" }, 0x99n),
    ];
    for (let n = 0; n <= log.length; n++) {
      const left = fold(log.slice(0, n));
      const right = fold(log.slice(0, n));
      expect(stateHash(left)).toBe(stateHash(right));
      if (n < log.length) {
        expect(stateHash(left)).not.toBe(stateHash(fold(log)));
      }
    }
  });

  it("ignores a repeated op wherever it lands in the log", () => {
    const move = patch(ana, 1, { x: 5 });
    const once = fold([create(ana, 0), move, patch(ben, 0, { x: 8 })]);
    const twice = fold([create(ana, 0), move, patch(ben, 0, { x: 8 }), move]);
    expect(stateHash(twice)).toBe(stateHash(once));
    expect(twice.shapes.get(box)?.fields.x).toBe(8);
  });

  it("ignores patches that land after a delete", () => {
    const deleted = fold([
      create(ana, 0),
      { sid: ben, seq: 0, shape: box, kind: "delete", fields: {} },
      patch(ana, 1, { x: 1 }),
    ]);
    expect(deleted.shapes.size).toBe(0);
  });

  it("never changes a shape's type or a finished stroke's points", () => {
    const stroke = create(ana, 0, box, { type: "stroke", points: [0, 0, 4, 4] });
    const doc = fold([stroke, patch(ben, 0, { type: "rect", points: [9, 9], x: 2 })]);
    expect(doc.shapes.get(box)?.fields).toMatchObject({
      type: "stroke",
      points: [0, 0, 4, 4],
      x: 2,
    });
  });

  it("drops creates of unknown types and z keys that are not keys", () => {
    const doc = fold([
      create(ana, 0, 1n, { type: "hexagon" }),
      create(ana, 1, 2n, { z: "not a key!" }),
      patch(ana, 2, { z: "" }, 2n),
    ]);
    expect([...doc.shapes.keys()]).toEqual([2n]);
    expect(doc.shapes.get(2n)?.fields.z).toBeUndefined();
  });

  it("returns the same document for an op that changes nothing", () => {
    const doc = fold([create(ana, 0)]);
    const unchanged = apply(doc, patch(ben, 0, { points: [1] }), 1);
    expect(unchanged.shapes).toBe(doc.shapes);
  });
});

describe("inZOrder", () => {
  it("sorts by z key, then by id", () => {
    const doc = fold([
      create(ana, 0, 3n, { z: "a" }),
      create(ana, 1, 2n, { z: "V" }),
      create(ana, 2, 1n, { z: "a" }),
    ]);
    expect(inZOrder(doc).map(([id]) => id)).toEqual([2n, 1n, 3n]);
  });
});

describe("stateHash", () => {
  it("depends on values, not on the order shapes or fields were written in", () => {
    const one = fold([create(ana, 0, 1n), create(ana, 1, 2n, { x: 4, label: "a" })]);
    const other = fold([create(ben, 0, 2n, { label: "a", x: 4 }), create(ben, 1, 1n)]);
    expect(stateHash(one)).toBe(stateHash(other));
    expect(stateHash(one)).toMatch(/^[0-9a-f]{16}$/);
    expect(stateHash(apply(one, patch(ana, 2, { x: 5 }, 2n), 2))).not.toBe(stateHash(one));
  });

  it("hashes the empty document to FNV-1a of an empty map", () => {
    // 0x80 is MessagePack's empty map.
    expect(stateHash(EMPTY_DOC)).toBe("af643d4c8602915f");
  });
});
