import { describe, expect, it } from "vitest";

import { isZKey, keyBetween } from "../src/index.js";

describe("keyBetween", () => {
  it("finds a key strictly between any two neighbours", () => {
    const keys = [keyBetween(null, null)];
    // Insert at the top, at the bottom, and repeatedly into the same gap.
    for (let i = 0; i < 200; i++) {
      keys.push(keyBetween(keys.at(-1)!, null));
      keys.unshift(keyBetween(null, keys[0]!));
      const mid = Math.floor(keys.length / 2);
      keys.splice(mid, 0, keyBetween(keys[mid - 1]!, keys[mid]!));
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
    expect(keys.every(isZKey)).toBe(true);
  });

  it("stays short when appending", () => {
    let key = keyBetween(null, null);
    for (let i = 0; i < 1000; i++) key = keyBetween(key, null);
    expect(key.length).toBeLessThan(40);
  });

  it("refuses neighbours out of order or malformed", () => {
    expect(() => keyBetween("b", "a")).toThrow(RangeError);
    expect(() => keyBetween("a", "a")).toThrow(RangeError);
    expect(() => keyBetween("a0", null)).toThrow(RangeError);
    expect(() => keyBetween("", null)).toThrow(RangeError);
  });
});
