import {
  EMPTY_DOC,
  apply,
  decodeSnapshot,
  encodeOp,
  stateHash,
  type Op,
} from "@felix-canvas/model";
import { describe, expect, it } from "vitest";

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

  constructor(records: Op[]) {
    this.#records = records.map((op, i) => ({ offset: BigInt(i), payload: encodeOp(op) }));
  }

  async poll(max: number): Promise<GroupRecord[]> {
    const free = this.#records.filter(
      ({ offset }) => !this.acked.has(offset) && !this.#claimed.has(offset),
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

  crash(): void {
    this.#claimed.clear();
  }
}

async function drain(snapshotter: Snapshotter, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) await snapshotter.step(0);
}

describe("Snapshotter", () => {
  it("writes every 500 records and acknowledges only what a snapshot holds", async () => {
    const group = new FakeGroup(ops);
    const snapshotter = new Snapshotter(group, { everyOps: 500, everyMs: 60_000 });
    await snapshotter.start();
    await drain(snapshotter, 13);

    expect(snapshotter.position).toEqual({ applied: 1199, saved: 999 });
    expect(group.ackedAbove).toEqual([]);
    expect(group.acked.size).toBe(1000);
  });

  it("writes what is left once the oldest unsaved record has waited long enough", async () => {
    let now = 0;
    const group = new FakeGroup(ops);
    const snapshotter = new Snapshotter(group, { everyOps: 500, everyMs: 30_000 }, () => now);
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
    const schedule = { everyOps: 500, everyMs: 60_000 };
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
    const snapshotter = new Snapshotter(group, { everyOps: 1, everyMs: 0 });
    await snapshotter.step(0);
    const saved = group.snapshot;
    group.acked.delete(5n);
    group.crash();
    await snapshotter.step(0);
    expect(group.snapshot).toBe(saved);
    expect(group.acked.has(5n)).toBe(true);
  });
});
