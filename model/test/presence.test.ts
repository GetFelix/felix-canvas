import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";

import {
  MAX_U128,
  PresenceDecodeError,
  decodePresence,
  encodePresence,
  type Presence,
} from "../src/index.js";

const cursor: Presence = {
  sid: 0x1234_5678_9abc_def0n,
  n: 12,
  name: "Otter",
  color: 3,
  cursor: { x: 10.5, y: -4 },
  selection: [1n, MAX_U128],
};

describe("encodePresence and decodePresence", () => {
  it("round-trip a cursor, a hidden cursor and a goodbye", () => {
    for (const presence of [
      cursor,
      { ...cursor, cursor: null, selection: [] },
      { ...cursor, gone: true },
    ]) {
      expect(decodePresence(encodePresence(presence))).toEqual(presence);
    }
  });

  it("stay small enough to send every frame", () => {
    expect(encodePresence({ ...cursor, selection: [] }).length).toBeLessThan(60);
  });

  it("reject bytes that are not presence", () => {
    const valid = { sid: 1, n: 0, name: "a", color: 0, x: 0, y: 0, sel: [] };
    for (const bytes of [
      new Uint8Array([0xc1]),
      encode([1]),
      encode({ ...valid, sid: -1 }),
      encode({ ...valid, n: 1.5 }),
      encode({ ...valid, name: 3 }),
      encode({ ...valid, sel: [1] }),
    ]) {
      expect(() => decodePresence(bytes)).toThrow(PresenceDecodeError);
    }
  });
});
