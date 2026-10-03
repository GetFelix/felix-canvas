import { describe, expect, it } from "vitest";

import { EMPTY_DOC, History, apply, stateHash, type Doc, type Op } from "../src/index.js";

/** A seeded log of creates, moves, deletes, repeats and records that are not ops. */
function randomLog(length: number, seed: number): (Op | null)[] {
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const seqs = [0, 0, 0];
  const log: (Op | null)[] = [];
  while (log.length < length) {
    const roll = random();
    const session = Math.floor(random() * 3);
    const shape = BigInt(1 + Math.floor(random() * 60));
    const sid = BigInt(session + 1);
    if (roll < 0.03) {
      log.push(null);
    } else if (roll < 0.06 && log.length > 0) {
      // A retried publish landing again further on.
      log.push(log[Math.floor(random() * log.length)] ?? null);
    } else {
      const seq = seqs[session]!++;
      const kind = roll < 0.25 ? "create" : roll < 0.3 ? "delete" : "patch";
      const fields =
        kind === "create"
          ? { type: "rect", x: 0, y: 0, w: 10, h: 10, z: "V" }
          : kind === "patch"
            ? { x: Math.round(random() * 500), y: Math.round(random() * 500) }
            : {};
      log.push({ sid, seq, shape, kind, fields });
    }
  }
  return log;
}

/** The hash of a fresh fold of `log` to every position from `start`, on top of `base`. */
function freshHashes(log: (Op | null)[], base: Doc, start: number): string[] {
  const hashes = [stateHash(base)];
  let doc = base;
  for (let offset = start; offset < log.length; offset++) {
    const op = log[offset];
    if (op) doc = apply(doc, op, offset);
    hashes.push(stateHash(doc));
  }
  return hashes;
}

describe("History", () => {
  const log = randomLog(3000, 7);

  it("gives the same state as a fresh fold at every position, scrubbed in any order", () => {
    const history = new History();
    for (const op of log) history.push(op);
    const expected = freshHashes(log, EMPTY_DOC, 0);

    // Forwards, backwards, then jumps both ways, as a playhead dragged back and forth would.
    const positions = [
      ...expected.keys(),
      ...[...expected.keys()].reverse(),
      ...Array.from({ length: 2000 }, (_, i) => (i * 7919) % expected.length),
    ];
    for (const position of positions) {
      expect(stateHash(history.at(position)), `position ${position}`).toBe(expected[position]);
    }
  });

  it("starts from a state that stands in for a log trimmed below it", () => {
    const start = 1100;
    const base = log
      .slice(0, start)
      .reduce<Doc>((doc, op, i) => (op ? apply(doc, op, i) : doc), EMPTY_DOC);
    const history = new History(base, start);
    for (const op of log.slice(start)) history.push(op);
    const expected = freshHashes(log, base, start);

    for (let position = log.length; position >= start; position -= 13) {
      expect(stateHash(history.at(position))).toBe(expected[position - start]);
    }
    expect(() => history.at(start - 1)).toThrow(RangeError);
    expect(() => history.at(log.length + 1)).toThrow(RangeError);
  });

  it("keeps up with records appended while it is being scrubbed", () => {
    const history = new History();
    const expected = freshHashes(log, EMPTY_DOC, 0);
    for (const [offset, op] of log.entries()) {
      history.push(op);
      if (offset % 97 === 0) {
        const back = Math.floor(offset / 2);
        expect(stateHash(history.at(back))).toBe(expected[back]);
        expect(stateHash(history.at(history.end))).toBe(expected[history.end]);
      }
    }
  });
});
