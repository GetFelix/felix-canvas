import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ownName, personId, saveName } from "../src/peers.js";

const jwt = (payload: object) => `e30.${btoa(JSON.stringify(payload)).replace(/=+$/, "")}.c2ln`;
const ana = jwt({ iss: "https://idp.example", sub: "ana", name: "Ana" });
const ben = jwt({ iss: "https://idp.example", sub: "ben", name: "Ben" });

describe("personId", () => {
  it("is the same for every sign-in to one account", () => {
    const again = jwt({ iss: "https://idp.example", sub: "ana", name: "Ana L.", exp: 1 });
    expect(personId(again)).toBe(personId(ana));
  });

  it("differs between accounts, including one subject at two providers", () => {
    const elsewhere = jwt({ iss: "https://other.example", sub: "ana" });
    expect(personId(ben)).not.toBe(personId(ana));
    expect(personId(elsewhere)).not.toBe(personId(ana));
  });

  it("fits in 64 bits", () => {
    expect(personId(ana) >> 64n).toBe(0n);
  });
});

describe("ownName", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts as the account's name", () => {
    expect(ownName(personId(ana), ana)).toBe("Ana");
  });

  it("keeps a rename for that account only", () => {
    saveName(personId(ana), "Ana B.");
    expect(ownName(personId(ana), ana)).toBe("Ana B.");
    expect(ownName(personId(ben), ben)).toBe("Ben");
  });
});
