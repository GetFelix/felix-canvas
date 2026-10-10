import { describe, expect, it } from "vitest";

import { Coalescer, WriteBudget } from "../src/coalesce.js";

/** The times `take` said to send, calling it every `frameMs` until `untilMs`. */
function sends(coalescer: Coalescer, frameMs: number, untilMs: number, moving: boolean): number[] {
  const sent: number[] = [];
  for (let now = 0; now <= untilMs; now += frameMs) {
    if (moving) for (let i = 0; i < 5; i++) coalescer.mark();
    if (coalescer.take(now)) sent.push(now);
  }
  return sent;
}

describe("Coalescer", () => {
  it("sends one message a frame however many moves the frame saw", () => {
    expect(sends(new Coalescer(16, 3000), 16, 64, true)).toEqual([0, 16, 32, 48, 64]);
  });

  it("holds a faster screen to the gap", () => {
    expect(sends(new Coalescer(16, 3000), 8, 64, true)).toEqual([0, 16, 32, 48, 64]);
  });

  it("sends nothing between heartbeats while nothing changes", () => {
    expect(sends(new Coalescer(16, 3000), 16, 6400, false)).toEqual([0, 3008, 6016]);
  });

  it("sends a change made between frames on the next one", () => {
    const coalescer = new Coalescer(16, 3000);
    coalescer.take(0);
    expect(coalescer.take(100)).toBe(false);
    coalescer.mark();
    expect(coalescer.take(116)).toBe(true);
    expect(coalescer.take(132)).toBe(false);
  });
});

describe("WriteBudget", () => {
  it("allows the burst at once, then the rate", () => {
    const budget = new WriteBudget(20, 40, 0);
    let burst = 0;
    while (budget.take(0)) burst++;
    expect(burst).toBe(40);
    expect(budget.wait(0)).toBe(50);
    expect(budget.take(49)).toBe(false);
    expect(budget.take(50)).toBe(true);

    let sent = 0;
    for (let now = 50; now <= 1050; now += 10) if (budget.take(now)) sent++;
    expect(sent).toBe(20);
  });

  it("refills no further than the burst", () => {
    const budget = new WriteBudget(20, 40, 0);
    let burst = 0;
    while (budget.take(60_000)) burst++;
    expect(burst).toBe(40);
  });
});
