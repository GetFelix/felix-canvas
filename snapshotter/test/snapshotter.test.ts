import {
  EMPTY_DOC,
  apply,
  decodeSnapshot,
  encodeOp,
  mergeTextUpdates,
  plainText,
  stateHash,
  textClientId,
  type Op,
} from "@felix-canvas/model";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { Snapshotter, type GroupRecord, type RoomLog } from "../src/snapshotter.js";

const ops: Op[] = Array.from({ length: 1200 }, (_, i) =>
  i < 10
    ? {
        sid: 7n,
        seq: i,
        shape: BigInt(i),
        kind: "create",
        fields: { type: "rect", x: 0, y: 0, w: 10, h: 10, z: "V" },
      }
    : { sid: BigInt(i % 3), seq: i, shape: BigInt(i % 10), kind: "patch", fields: { x: i } },
);
const hashOf = (count: number) =>
  stateHash(ops.slice(0, count).reduce((doc, op, i) => apply(doc, op, i), EMPTY_DOC));

/**
 * A consumer group over `ops`: hands out records nobody holds in offset
 * order, and drops every claim when a consumer crashes.
 */
class FakeGroup implements RoomLog {
  snapshot: Uint8Array | null = null;
  readonly acked = new Set<bigint>();
  readonly #claimed = new Set<bigint>();
  readonly #records: GroupRecord[];
  /** What an ack found stored, to check it never runs ahead of the snapshot. */
  readonly ackedAbove: bigint[] = [];

  /** Records the group holds back once, as a lost claim from a previous member would be. */
  readonly #late: Set<bigint>;

  constructor(records: Op[], late: number[] = []) {
    this.#records = records.map((op, i) => ({ offset: BigInt(i), payload: encodeOp(op) }));
    this.#late = new Set(late.map(BigInt));
  }

  async poll(max: number): Promise<GroupRecord[]> {
    const free = this.#records.filter(
      ({ offset }) =>
        !this.acked.has(offset) && !this.#claimed.has(offset) && !this.#late.has(offset),
    );
    const batch = free.slice(0, Math.min(max, 100));
    for (const { offset } of batch) this.#claimed.add(offset);
    return batch;
  }

  async ack(offset: bigint): Promise<void> {
    const saved = this.snapshot ? decodeSnapshot(this.snapshot).offset : -1;
    if (offset > BigInt(saved)) this.ackedAbove.push(offset);
    this.acked.add(offset);
  }

  async readSnapshot(): Promise<Uint8Array | null> {
    return this.snapshot;
  }

  async writeSnapshot(bytes: Uint8Array): Promise<void> {
    this.snapshot = bytes;
  }

  /** Every claim lapses: the consumer crashed, or waited out the visibility timeout. */
  crash(): void {
    this.#claimed.clear();
    this.#late.clear();
  }
}

/** A rectangle typed into by two sessions in turn, each op building on the last. */
function typing(count: number): Op[] {
  const docs = [1n, 2n].map((sid) => {
    const doc = new Y.Doc();
    doc.clientID = textClientId(sid);
    return doc;
  });
  const ops: Op[] = [
    {
      sid: 9n,
      seq: 0,
      shape: 1n,
      kind: "create",
      fields: { type: "rect", x: 0, y: 0, w: 9, h: 9 },
    },
  ];
  for (let i = 0; i < count; i++) {
    const author = i % 2;
    const doc = docs[author]!;
    const updates: Uint8Array[] = [];
    const listen = (update: Uint8Array) => updates.push(update);
    doc.on("updateV2", listen);
    doc.transact(() => {
      const body = doc.getXmlFragment("body");
      if (body.length === 0) body.insert(0, [new Y.XmlElement("p")]);
      const p = body.get(0) as Y.XmlElement;
      if (p.length === 0) p.insert(0, [new Y.XmlText()]);
      (p.get(0) as Y.XmlText).insert(0, `${i},`);
    });
    doc.off("updateV2", listen);
    const y = mergeTextUpdates(updates);
    Y.applyUpdateV2(docs[1 - author]!, y);
    ops.push({
      sid: BigInt(author + 1),
      seq: Math.floor(i / 2),
      shape: 1n,
      kind: "text",
      fields: { y },
    });
  }
  return ops;
}

const textOf = (bytes: Uint8Array) =>
  plainText(decodeSnapshot(bytes).doc.texts.get(1n)?.content ?? []);

async function drain(snapshotter: Snapshotter, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) await snapshotter.step(0);
}

describe("Snapshotter", () => {
  it("writes every 500 records and acknowledges only what a snapshot holds", async () => {
    const group = new FakeGroup(ops);
    const snapshotter = new Snapshotter(group, { everyOps: 500, everyMs: 60_000, claimMs: 0 });
    await snapshotter.start();
    await drain(snapshotter, 13);

    expect(snapshotter.position).toEqual({ applied: 1199, saved: 999 });
    expect(group.ackedAbove).toEqual([]);
    expect(group.acked.size).toBe(1000);
  });

  it("writes what is left once the oldest unsaved record has waited long enough", async () => {
    let now = 0;
    const group = new FakeGroup(ops);
    const snapshotter = new Snapshotter(
      group,
      { everyOps: 500, everyMs: 30_000, claimMs: 0 },
      () => now,
    );
    await drain(snapshotter, 13);
    expect(snapshotter.position.saved).toBe(999);

    now = 29_999;
    await snapshotter.step(0);
    expect(snapshotter.position.saved).toBe(999);
    now = 30_000;
    await snapshotter.step(0);
    expect(snapshotter.position.saved).toBe(1199);
    expect(group.acked.size).toBe(1200);
    expect(stateHash(decodeSnapshot(group.snapshot!).doc)).toBe(hashOf(1200));
  });

  it("ends with the same snapshot after a crash between writes", async () => {
    const group = new FakeGroup(ops);
    const schedule = { everyOps: 500, everyMs: 60_000, claimMs: 0 };
    const first = new Snapshotter(group, schedule, () => 0);
    await drain(first, 7);
    expect(first.position).toEqual({ applied: 699, saved: 499 });
    // Records 500 to 699 are held but unacknowledged when it stops.
    group.crash();

    const second = new Snapshotter(group, schedule, () => 0);
    await second.start();
    await drain(second, 8);
    expect(second.position).toEqual({ applied: 1199, saved: 999 });
    expect(group.ackedAbove).toEqual([]);
    expect(stateHash(decodeSnapshot(group.snapshot!).doc)).toBe(hashOf(1000));
  });

  it("skips redelivered records and acknowledges them again", async () => {
    const group = new FakeGroup(ops.slice(0, 20));
    const snapshotter = new Snapshotter(group, { everyOps: 1, everyMs: 0, claimMs: 0 });
    await snapshotter.step(0);
    const saved = group.snapshot;
    group.acked.delete(5n);
    group.crash();
    await snapshotter.step(0);
    expect(group.snapshot).toBe(saved);
    expect(group.acked.has(5n)).toBe(true);
  });

  it("keeps text and starts again when it finds a skipped text op", async () => {
    const ops = typing(40);
    const whole = ops.reduce((doc, op, i) => apply(doc, op, i), EMPTY_DOC);
    let now = 0;
    // Offset 10 comes back only after the claim on it lapses, behind newer records.
    const group = new FakeGroup(ops, [10]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshotter = new Snapshotter(
      group,
      { everyOps: 20, everyMs: 60_000, claimMs: 30_000 },
      () => now,
      async (ms) => {
        now += ms;
        group.crash();
      },
    );
    await drain(snapshotter, 10);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(group.ackedAbove).toEqual([]);
    expect(snapshotter.position.saved).toBe(40);
    expect(textOf(group.snapshot!)).toBe(plainText(whole.texts.get(1n)!.content));
    expect(stateHash(decodeSnapshot(group.snapshot!).doc)).toBe(stateHash(whole));
  });

  it("saves a body the log itself leaves waiting, after one retry", async () => {
    const ops = typing(30);
    // The op is gone from the log for good, so the others by its author wait forever.
    ops[5] = { ...ops[5]!, fields: { y: new Uint8Array([0xc1]) } };
    let now = 0;
    const group = new FakeGroup(ops);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshotter = new Snapshotter(
      group,
      { everyOps: 10, everyMs: 60_000, claimMs: 1000 },
      () => now,
      async (ms) => {
        now += ms;
        group.crash();
      },
    );
    await drain(snapshotter, 12);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    expect(snapshotter.position.saved).toBe(30);
    const expected = ops.reduce((doc, op, i) => apply(doc, op, i), EMPTY_DOC);
    expect(stateHash(decodeSnapshot(group.snapshot!).doc)).toBe(stateHash(expected));
  });
});
