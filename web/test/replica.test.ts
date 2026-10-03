import {
  EMPTY_DOC,
  apply,
  encodeOp,
  mergeTextUpdates,
  plainText,
  stateHash,
  textClientId,
  type Op,
} from "@felix-canvas/model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

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

/** A session typing into one body, as the editor does. */
function typist(sid: bigint) {
  const doc = new Y.Doc();
  doc.clientID = textClientId(sid);
  const out: Uint8Array[] = [];
  doc.on("updateV2", (update: Uint8Array, origin: unknown) => {
    if (origin !== "log") out.push(update);
  });
  let seq = 0;
  return {
    see(op: Op) {
      Y.applyUpdateV2(doc, op.fields.y as Uint8Array, "log");
    },
    type(shape: bigint, change: (body: Y.XmlFragment) => void): Op {
      doc.transact(() => change(doc.getXmlFragment("body")));
      const y = mergeTextUpdates(out.splice(0));
      return { sid, seq: seq++, shape, kind: "text", fields: { y } };
    },
  };
}

const paragraph = (text: string) => {
  const p = new Y.XmlElement("p");
  const run = new Y.XmlText();
  run.insert(0, text);
  p.insert(0, [run]);
  return p;
};
const firstRun = (body: Y.XmlFragment) => (body.get(0) as Y.XmlElement).get(0) as Y.XmlText;

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

  it("ends with the same text when typing arrives out of order and repeated", () => {
    const a = typist(ana);
    const b = typist(ben);
    const ops: Op[] = [rect(me, 0, 1n)];
    ops.push(a.type(1n, (body) => body.insert(0, [paragraph("shared")])));
    b.see(ops[1]!);
    for (let i = 0; i < 20; i++) {
      // Each types a word before seeing the other's, then catches up.
      const fromA = a.type(1n, (body) => firstRun(body).insert(0, `a${i} `));
      const fromB = b.type(1n, (body) => firstRun(body).insert(firstRun(body).length, ` b${i}`));
      a.see(fromB);
      b.see(fromA);
      ops.push(fromA, fromB);
    }
    const records = ops.map((op, offset) => ({ offset, payload: encodeOp(op) }));
    const inOrder = new Replica(me);
    for (const { offset, payload } of records) inOrder.deliver(offset, 0, payload);
    const text = plainText(inOrder.confirmed.texts.get(1n)!.content);
    expect(text).toContain("a19 ");
    expect(text).toContain(" b19");

    for (let seed = 1; seed <= 5; seed++) {
      const random = seeded(seed);
      const arrivals = [...records, ...records.filter(() => random() < 0.3)];
      arrivals.sort(() => random() - 0.5);
      const replica = new Replica(me);
      for (const { offset, payload } of arrivals) replica.deliver(offset, 0, payload);
      expect(stateHash(replica.confirmed)).toBe(stateHash(inOrder.confirmed));
    }
  });

  it("shows pending text on the canvas until the log hands it back", () => {
    const a = typist(me);
    const replica = new Replica(me);
    replica.deliver(0, 0, encodeOp(rect(ana, 0, 1n)));
    const first = a.type(1n, (body) => body.insert(0, [paragraph("Hello")]));
    const second = a.type(1n, (body) => firstRun(body).insert(5, " there"));
    replica.edit(first);
    replica.edit(second);
    const shown = () => plainText(replica.view().texts.get(1n)?.content ?? []);
    expect(shown()).toBe("Hello there");
    expect(replica.confirmed.texts.size).toBe(0);
    replica.deliver(1, 0, encodeOp(first));
    expect(shown()).toBe("Hello there");
    replica.deliver(2, 0, encodeOp(second));
    expect(replica.pending).toEqual([]);
    expect(plainText(replica.confirmed.texts.get(1n)!.content)).toBe("Hello there");
  });

  it("folds unsent typing into the newest unsent op for the body", () => {
    const a = typist(me);
    const replica = new Replica(me);
    replica.deliver(0, 0, encodeOp(rect(ana, 0, 1n)));
    replica.edit(a.type(1n, (body) => body.insert(0, [paragraph("one")])));
    replica.edit(move(me, 1, 1n, 5));
    for (const word of [" two", " three"]) {
      const op = a.type(1n, (body) => firstRun(body).insert(firstRun(body).length, word));
      expect(replica.amend("text", 1n, op.fields)).toBe(true);
    }
    expect(replica.pending.map(({ op }) => op.kind)).toEqual(["text", "patch"]);
    expect(plainText(replica.view().texts.get(1n)!.content)).toBe("one two three");
    replica.pending[0]!.sentAt = 0;
    expect(replica.amend("text", 1n, a.type(1n, () => {}).fields)).toBe(false);
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
    expect(replica.amend("patch", 1n, { x: 2, y: 3 })).toBe(true);
    expect(replica.amend("patch", 2n, { x: 2 })).toBe(false);
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

  it("continues from a snapshot, applying buffered records past it", () => {
    const records = log();
    const inOrder = new Replica(me);
    for (const record of records)
      inOrder.deliver(record.offset, record.skippedBefore, record.payload);

    // A snapshot of offsets 0 to 4, while records from 6 on are already buffered.
    const snapshot = [rect(ana, 0, 1n), rect(ben, 0, 2n), move(ana, 1, 2n, 5), move(ben, 1, 2n, 9)]
      .map((op, i) => [op, i < 3 ? i : 4] as const)
      .reduce((doc, [op, offset]) => apply(doc, op, offset), EMPTY_DOC);
    const replica = new Replica(me);
    for (const record of records.slice(5)) {
      replica.deliver(record.offset, record.skippedBefore, record.payload);
    }
    expect(replica.hasGap).toBe(true);
    replica.reset(snapshot, 5);
    expect(replica.hasGap).toBe(true);
    const fifth = records[4]!;
    replica.deliver(fifth.offset, fifth.skippedBefore, fifth.payload);
    expect(replica.next).toBe(inOrder.next);
    expect(stateHash(replica.confirmed)).toBe(stateHash(inOrder.confirmed));
  });

  it("confirms pending edits a snapshot already holds", () => {
    const replica = new Replica(me);
    replica.edit(rect(me, 3, 1n));
    replica.edit(move(me, 4, 1n, 2));
    const snapshot = apply(EMPTY_DOC, rect(me, 3, 1n), 0);
    const confirmed = replica.reset(snapshot, 1);
    expect(confirmed.map(({ op }) => op.seq)).toEqual([3]);
    expect(replica.pending.map(({ op }) => op.seq)).toEqual([4]);
  });
});
