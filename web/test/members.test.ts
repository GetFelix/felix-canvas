import { encodeMember } from "@felix-canvas/model";
import { describe, expect, it } from "vitest";

import { Members, assignColor, memberKey, type MemberEntry } from "../src/members.js";

const ana = 0xaaaan;
const ben = 0xbbbbn;

const entry = (sid: bigint, name: string, expiresInMs: number | null = 30_000): MemberEntry => ({
  key: memberKey(sid),
  payload: encodeMember({ name, color: 0 }),
  expiresInMs,
});
const names = (members: Members) => members.list().map((member) => member.name);

describe("Members", () => {
  it("lists who is here in the order they arrived", () => {
    const members = new Members();
    expect(members.apply(entry(ben, "Ben"), 0)).toBe(true);
    expect(members.apply(entry(ana, "Ana"), 0)).toBe(true);
    expect(names(members)).toEqual(["Ben", "Ana"]);
    expect(members.list()[1]!.sid).toBe(ana);
  });

  it("reports a refresh as no change, and a rename as one", () => {
    const members = new Members();
    members.apply(entry(ana, "Ana"), 0);
    expect(members.apply(entry(ana, "Ana"), 10_000)).toBe(false);
    expect(members.apply(entry(ana, "Ana B."), 10_000)).toBe(true);
  });

  it("drops an entry at its deadline unless it was refreshed", () => {
    const members = new Members();
    members.apply(entry(ana, "Ana"), 0);
    members.apply(entry(ben, "Ben"), 0);
    members.apply(entry(ben, "Ben"), 20_000);
    expect(members.expire(29_999)).toBe(false);
    expect(members.expire(30_000)).toBe(true);
    expect(names(members)).toEqual(["Ben"]);
    expect(members.expire(49_999)).toBe(false);
    expect(members.expire(50_000)).toBe(true);
    expect(names(members)).toEqual([]);
  });

  it("keeps an entry that never expires", () => {
    const members = new Members();
    members.apply(entry(ana, "Ana", null), 0);
    expect(members.expire(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("removes a deleted entry at once", () => {
    const members = new Members();
    members.apply(entry(ana, "Ana"), 0);
    expect(members.apply({ key: memberKey(ana), payload: null, expiresInMs: null }, 1)).toBe(true);
    expect(members.apply({ key: memberKey(ana), payload: null, expiresInMs: null }, 2)).toBe(false);
    expect(names(members)).toEqual([]);
  });

  it("replaces everything with the list a new watch starts with", () => {
    const members = new Members();
    members.apply(entry(ana, "Ana"), 0);
    members.reset([entry(ben, "Ben", 5_000)], 1_000);
    expect(names(members)).toEqual(["Ben"]);
    members.expire(6_000);
    expect(names(members)).toEqual([]);
  });

  it("ignores keys and values it cannot read", () => {
    const members = new Members();
    expect(members.apply({ ...entry(ana, "Ana"), key: "not-a-session" }, 0)).toBe(false);
    expect(members.apply({ ...entry(ana, "Ana"), payload: new Uint8Array([0xc1]) }, 0)).toBe(false);
    expect(names(members)).toEqual([]);
  });
});

describe("assignColor", () => {
  const member = (sid: bigint, color: number) => ({ sid, name: "", color });

  it("uses the session's hash when the colour is free", () => {
    expect(assignColor(10n, [])).toBe(2);
  });

  it("moves past colours held by members with smaller ids only", () => {
    expect(assignColor(10n, [member(1n, 2), member(2n, 3)])).toBe(4);
    expect(assignColor(10n, [member(11n, 2)])).toBe(2);
  });

  it("gives two sessions with the same hash different colours from either side", () => {
    const first = member(2n, assignColor(2n, []));
    const second = member(10n, assignColor(10n, [first]));
    expect(second.color).not.toBe(first.color);
    expect(assignColor(2n, [first, second])).toBe(first.color);
  });
});
