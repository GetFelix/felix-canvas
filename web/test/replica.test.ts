import { encodeOp, stateHash, type Op } from "@felix-canvas/model";
import { describe, expect, it } from "vitest";

import { Replica } from "../src/replica.js";

const me = 0x1111n;
const ana = 0xaaaan;
const ben = 0xbbbbn;

const rect = (sid: bigint, seq: number, shape: bigint): Op => ({
  sid,
  seq,
  shape,
  kind: "create",
  fields: { type: "rect", x: 0, y: 0, w: 10, h: 10, z: "V" },
});
const move = (sid: bigint, seq: number, shape: bigint, x: number): Op => ({
  sid,
  seq,
  shape,
  kind: "patch",
  fields: { x },
});

interface LogRecord {
  offset: number;
  skippedBefore: number;
  payload: Uint8Array;
}

/** A log of ops from three sessions, with a hole at offset 3 and a retried op. */
function log(): LogRecord[] {
  const ops = [
    rect(ana, 0, 1n),
    rect(ben, 0, 2n),
    move(ana, 1, 2n, 5),
    // offset 3 holds no event: a new leader's generation-start record.
    move(ben, 1, 2n, 9),
    move(ana, 2, 1n, 4),
    move(ben, 1, 2n, 9),
    rect(ana, 3, 3n),
    move(ben, 2, 3n, 7),
  ];
  return ops.map((op, i) => {
    const offset = i < 3 ? i : i + 1;
    return { offset, skippedBefore: offset === 4 ? 1 : 0, payload: encodeOp(op) };
  });
}

function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

describe("Replica", () => {
  it("ends in the in-order state when records arrive out of order and repeated", () => {
    const inOrder = new Replica(me);
    for (const record of log()) {
      inOrder.deliver(record.offset, record.skippedBefore, record.payload);
    }
    expect(inOrder.next).toBe(9);
    expect(inOrder.hasGap).toBe(false);

    for (let seed = 1; seed <= 25; seed++) {
      const random = seeded(seed);
      const deliveries = log().flatMap((record) =>
        Array.from({ length: 1 + Math.floor(random() * 3) }, () => record),
      );
      deliveries.sort(() => random() - 0.5);
      const replica = new Replica(me);
      for (const record of deliveries) {
        replica.deliver(record.offset, record.skippedBefore, record.payload);
      }
      expect(stateHash(replica.confirmed)).toBe(stateHash(inOrder.confirmed));
      expect(replica.next).toBe(inOrder.next);
      expect(replica.hasGap).toBe(false);
    }
  });

  it("waits for a missing offset before applying what follows it", () => {
    const replica = new Replica(me);
    const [first, second, third] = log();
    replica.deliver(first!.offset, 0, first!.payload);
    replica.deliver(third!.offset, 0, third!.payload);
    expect(replica.hasGap).toBe(true);
    expect(replica.confirmed.shapes.has(2n)).toBe(false);
    replica.deliver(second!.offset, 0, second!.payload);
    expect(replica.hasGap).toBe(false);
    expect(replica.confirmed.shapes.get(2n)?.fields.x).toBe(5);
  });

  it("shows a local edit at once and keeps it through concurrent remote writes", () => {
    const replica = new Replica(me);
    replica.deliver(0, 0, encodeOp(rect(ana, 0, 1n)));
    replica.edit(move(me, 7, 1n, 50));
    expect(replica.view().shapes.get(1n)?.fields.x).toBe(50);

    // Ana's move was admitted before ours, so ours wins once it lands.
    replica.deliver(1, 0, encodeOp(move(ana, 1, 1n, -3)));
    expect(replica.confirmed.shapes.get(1n)?.fields.x).toBe(-3);
    expect(replica.view().shapes.get(1n)?.fields.x).toBe(50);

    const confirmed = replica.deliver(2, 0, encodeOp(move(me, 7, 1n, 50)));
    expect(confirmed.map(({ op }) => op.seq)).toEqual([7]);
    expect(replica.pending).toHaveLength(0);
    expect(replica.view()).toBe(replica.confirmed);
    expect(replica.view().shapes.get(1n)?.fields.x).toBe(50);
  });

  it("lets a later remote write replace a confirmed local one", () => {
    const replica = new Replica(me);
    replica.deliver(0, 0, encodeOp(rect(ana, 0, 1n)));
    replica.edit(move(me, 0, 1n, 50));
    replica.deliver(1, 0, encodeOp(move(me, 0, 1n, 50)));
    replica.deliver(2, 0, encodeOp(move(ana, 1, 1n, 8)));
    expect(replica.view().shapes.get(1n)?.fields.x).toBe(8);
  });

  it("folds unsent patches of one shape into one pending op", () => {
    const replica = new Replica(me);
    replica.edit(rect(me, 0, 1n));
    replica.pending[0]!.sentAt = 0;
    replica.edit(move(me, 1, 1n, 1));
    expect(replica.amend(1n, { x: 2, y: 3 })).toBe(true);
    expect(replica.amend(2n, { x: 2 })).toBe(false);
    expect(replica.pending.map(({ op }) => op.fields)).toEqual([
      rect(me, 0, 1n).fields,
      { x: 2, y: 3 },
    ]);
    expect(replica.view().shapes.get(1n)?.fields).toMatchObject({ x: 2, y: 3 });
  });

  it("skips records that are not ops", () => {
    const replica = new Replica(me);
    replica.deliver(0, 0, new TextEncoder().encode("not an op"));
    replica.deliver(1, 0, encodeOp(rect(ana, 0, 1n)));
    expect(replica.next).toBe(2);
    expect(replica.confirmed.shapes.size).toBe(1);
  });
});
