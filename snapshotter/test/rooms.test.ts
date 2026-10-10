import { describe, expect, it } from "vitest";

import type { Identity } from "../src/rooms/idtoken.js";
import { readInvite, signInvite } from "../src/rooms/invite.js";
import type { RoomRecord } from "../src/rooms/record.js";
import {
  Rooms,
  RoomsError,
  newRoomId,
  type Limits,
  type Provisioner,
  type Registry,
} from "../src/rooms/service.js";

const SECRET = "a-test-secret-of-some-length";
const HOUR = 3_600_000;

const ana: Identity = { principal: "p-ana", name: "Ana" };
const ben: Identity = { principal: "p-ben", name: "Ben" };
const cleo: Identity = { principal: "p-cleo", name: "Cleo" };

/** Felix as the rooms service changes it: who holds each room's role, and which rooms exist. */
class FakeFelix implements Provisioner, Registry {
  readonly roles = new Map<string, Set<string>>();
  readonly records = new Map<string, RoomRecord>();
  failCreate = false;

  async create(room: string, owner: string): Promise<void> {
    if (this.failCreate) throw new Error("control plane down");
    this.roles.set(room, new Set([owner]));
  }
  async destroy(room: string): Promise<void> {
    this.roles.delete(room);
  }
  async grant(room: string, principal: string): Promise<void> {
    this.roles.get(room)!.add(principal);
  }
  async revoke(room: string, principal: string): Promise<void> {
    this.roles.get(room)?.delete(principal);
  }
  async put(record: RoomRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }
  async delete(room: string): Promise<void> {
    this.records.delete(room);
  }
  holders(room: string): string[] {
    return [...(this.roles.get(room) ?? [])].sort();
  }
}

function setup(limits: Partial<Limits> = {}) {
  const felix = new FakeFelix();
  let now = 1_000_000;
  let next = 0;
  const rooms = new Rooms({
    provisioner: felix,
    registry: felix,
    records: [],
    secret: SECRET,
    limits: {
      roomsPerUser: 2,
      membersPerRoom: 3,
      invitesPerRoom: 2,
      inviteTtlMs: 24 * HOUR,
      ...limits,
    },
    now: () => now,
    newRoomId: () => `room${next++}`,
  });
  return { felix, rooms, advance: (ms: number) => (now += ms) };
}

async function refused(promise: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (err) {
    expect(err).toBeInstanceOf(RoomsError);
    expect((err as RoomsError).code).toBe(code);
    return;
  }
  throw new Error(`expected a refusal with ${code}`);
}

describe("invite tokens", () => {
  it("read back what was signed", () => {
    const claims = { room: "r1", id: "abc", expires: 123 };
    expect(readInvite(SECRET, signInvite(SECRET, claims))).toEqual(claims);
  });

  it("are refused under another key or with any byte changed", () => {
    const token = signInvite(SECRET, { room: "r1", id: "abc", expires: 123 });
    expect(readInvite("another-secret-entirely", token)).toBeNull();
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify(["r2", "abc", 123])).toString("base64url");
    expect(readInvite(SECRET, `${forged}.${mac}`)).toBeNull();
    expect(readInvite(SECRET, `${body}.${mac!.slice(0, -1)}A`)).toBeNull();
    expect(readInvite(SECRET, "nonsense")).toBeNull();
  });
});

describe("room ids", () => {
  it("are names the gateway and Felix accept", () => {
    for (let i = 0; i < 100; i++) expect(newRoomId()).toMatch(/^r[a-z0-9]{11}$/);
  });
});

describe("rooms", () => {
  it("creating a room makes its creator the owner and its only member", async () => {
    const { felix, rooms } = setup();
    const view = await rooms.create(ana, "  Team   sketch ");
    expect(view).toMatchObject({
      id: "room0",
      title: "Team sketch",
      owner: true,
      ownerName: "Ana",
    });
    expect(view.members).toEqual([{ id: "p-ana", name: "Ana", owner: true, you: true }]);
    expect(felix.holders("room0")).toEqual(["p-ana"]);
    expect(felix.records.get("room0")?.owner).toBe("p-ana");
    expect(rooms.list(ana)).toEqual([
      { id: "room0", title: "Team sketch", owner: true, members: 1 },
    ]);
    expect(rooms.list(ben)).toEqual([]);
  });

  it("refuses a blank or overlong name", async () => {
    const { rooms } = setup();
    await refused(rooms.create(ana, "   "), "invalid");
    await refused(rooms.create(ana, "x".repeat(61)), "invalid");
    await refused(rooms.create(ana, 42), "invalid");
  });

  it("limits how many rooms one person owns", async () => {
    const { rooms } = setup();
    await rooms.create(ana, "One");
    await rooms.create(ana, "Two");
    await refused(rooms.create(ana, "Three"), "limit");
    // Someone else's count is their own.
    await rooms.create(ben, "Ben's");
  });

  it("a failed create leaves no record and frees its place in the limit", async () => {
    const { felix, rooms } = setup({ roomsPerUser: 1 });
    felix.failCreate = true;
    await expect(rooms.create(ana, "One")).rejects.toThrow("control plane down");
    expect(felix.records.size).toBe(0);
    felix.failCreate = false;
    await rooms.create(ana, "One");
  });

  it("only the owner invites, revokes, removes and deletes", async () => {
    const { rooms } = setup();
    const { id } = await rooms.create(ana, "Room");
    const { token } = await rooms.invite(ana, id);
    await rooms.accept(ben, token);
    await refused(rooms.invite(ben, id), "forbidden");
    await refused(rooms.revokeInvite(ben, id, "x"), "forbidden");
    await refused(rooms.removeMember(ben, id, ana.principal), "invalid");
    await refused(rooms.delete(ben, id), "forbidden");
    expect(rooms.get(ben, id).invites).toEqual([]);
    expect(rooms.get(ana, id).invites).toHaveLength(1);
  });

  it("someone outside a room cannot see or change it", async () => {
    const { rooms } = setup();
    const { id } = await rooms.create(ana, "Room");
    await refused(() => rooms.get(cleo, id), "not_found");
    await refused(rooms.invite(cleo, id), "not_found");
    await refused(rooms.delete(cleo, id), "not_found");
    await refused(rooms.removeMember(cleo, id, ana.principal), "not_found");
  });

  it("an invite adds whoever accepts it to the room's role", async () => {
    const { felix, rooms } = setup();
    const { id } = await rooms.create(ana, "Room");
    const { token } = await rooms.invite(ana, id);
    expect(rooms.preview(ben, token)).toMatchObject({
      room: id,
      title: "Room",
      ownerName: "Ana",
      member: false,
    });
    const view = await rooms.accept(ben, token);
    expect(view.owner).toBe(false);
    expect(view.members.map((member) => member.name)).toEqual(["Ana", "Ben"]);
    expect(felix.holders(id)).toEqual(["p-ana", "p-ben"]);
    expect(rooms.preview(ben, token).member).toBe(true);
    // Accepting twice changes nothing.
    await rooms.accept(ben, token);
    expect(felix.records.get(id)!.members["p-ben"]).toBeDefined();
    expect(rooms.list(ben)).toEqual([{ id, title: "Room", owner: false, members: 2 }]);
  });

  it("joining needs a valid invite for that very room", async () => {
    const { rooms } = setup();
    const { id } = await rooms.create(ana, "Room");
    const other = await rooms.create(ana, "Other");
    const { token } = await rooms.invite(ana, id);
    // A link signed with another key, or for a room it was not made for.
    const forged = signInvite("not-the-service-secret", readInvite(SECRET, token)!);
    await refused(rooms.accept(ben, forged), "invite_invalid");
    const { id: inviteId, expires } = readInvite(SECRET, token)!;
    const moved = signInvite(SECRET, { room: other.id, id: inviteId, expires });
    await refused(rooms.accept(ben, moved), "invite_invalid");
    await refused(rooms.accept(ben, "garbage"), "invite_invalid");
    // A made-up later expiry is signed, but the room keeps the real one.
    const { token: real } = await rooms.invite(ana, id);
    const claims = readInvite(SECRET, real)!;
    expect(rooms.preview(ben, signInvite(SECRET, { ...claims, expires: 9e15 })).expires).toBe(
      claims.expires,
    );
  });

  it("an invite stops working when it expires", async () => {
    const { rooms, advance } = setup();
    const { id } = await rooms.create(ana, "Room");
    const { token, expires } = await rooms.invite(ana, id);
    expect(expires).toBe(1_000_000 + 24 * HOUR);
    advance(24 * HOUR - 1);
    expect(rooms.preview(ben, token).room).toBe(id);
    advance(1);
    await refused(() => rooms.preview(ben, token), "invite_expired");
    await refused(rooms.accept(ben, token), "invite_expired");
    expect(rooms.get(ana, id).invites).toEqual([]);
  });

  it("an invite stops working when the owner revokes it", async () => {
    const { felix, rooms } = setup();
    const { id } = await rooms.create(ana, "Room");
    const first = await rooms.invite(ana, id);
    const second = await rooms.invite(ana, id);
    await rooms.revokeInvite(ana, id, first.id);
    await refused(rooms.accept(ben, first.token), "invite_invalid");
    await rooms.accept(cleo, second.token);
    expect(felix.holders(id)).toEqual(["p-ana", "p-cleo"]);
    expect(rooms.get(ana, id).invites).toEqual([
      { id: second.id, token: second.token, expires: second.expires },
    ]);
    await refused(rooms.revokeInvite(ana, id, first.id), "not_found");
  });

  it("limits open invites, counting only those that have not expired", async () => {
    const { rooms, advance } = setup();
    const { id } = await rooms.create(ana, "Room");
    await rooms.invite(ana, id);
    await rooms.invite(ana, id);
    await refused(rooms.invite(ana, id), "limit");
    advance(24 * HOUR);
    await rooms.invite(ana, id);
  });

  it("limits how many people a room holds", async () => {
    const { rooms } = setup({ membersPerRoom: 2 });
    const { id } = await rooms.create(ana, "Room");
    const { token } = await rooms.invite(ana, id);
    await rooms.accept(ben, token);
    await refused(rooms.accept(cleo, token), "limit");
    await rooms.removeMember(ana, id, ben.principal);
    await rooms.accept(cleo, token);
  });

  it("removing someone takes the role away, and they cannot come back on their own", async () => {
    const { felix, rooms } = setup();
    const { id } = await rooms.create(ana, "Room");
    const { token, id: invite } = await rooms.invite(ana, id);
    await rooms.accept(ben, token);
    await rooms.removeMember(ana, id, ben.principal);
    expect(felix.holders(id)).toEqual(["p-ana"]);
    await refused(() => rooms.get(ben, id), "not_found");
    expect(rooms.list(ben)).toEqual([]);
    // The link still works until the owner revokes it.
    await rooms.revokeInvite(ana, id, invite);
    await refused(rooms.accept(ben, token), "invite_invalid");
  });

  it("members may leave, and the owner may not", async () => {
    const { felix, rooms } = setup();
    const { id } = await rooms.create(ana, "Room");
    const { token } = await rooms.invite(ana, id);
    await rooms.accept(ben, token);
    await rooms.accept(cleo, token);
    await refused(rooms.removeMember(ben, id, cleo.principal), "forbidden");
    await rooms.removeMember(ben, id, "me");
    expect(felix.holders(id)).toEqual(["p-ana", "p-cleo"]);
    await refused(rooms.removeMember(ana, id, "me"), "invalid");
  });

  it("deleting a room removes its record and everything in Felix", async () => {
    const { felix, rooms } = setup();
    const { id } = await rooms.create(ana, "Room");
    const { token } = await rooms.invite(ana, id);
    await rooms.accept(ben, token);
    await rooms.delete(ana, id);
    expect(felix.records.has(id)).toBe(false);
    expect(felix.roles.has(id)).toBe(false);
    expect(rooms.list(ana)).toEqual([]);
    expect(rooms.list(ben)).toEqual([]);
    await refused(rooms.accept(cleo, token), "invite_invalid");
    // Deleting frees a place in the owner's limit.
    expect(rooms.owned(ana)).toBe(0);
  });

  it("starts from the records the registry already holds", async () => {
    const { felix, rooms } = setup();
    const { id } = await rooms.create(ana, "Room");
    const { token } = await rooms.invite(ana, id);
    const restarted = new Rooms({
      provisioner: felix,
      registry: felix,
      records: [...felix.records.values()],
      secret: SECRET,
      now: () => 1_000_000,
    });
    expect(restarted.list(ana)).toEqual(rooms.list(ana));
    await restarted.accept(ben, token);
    expect(felix.holders(id)).toEqual(["p-ana", "p-ben"]);
  });

  it("runs changes one at a time, so two accepts cannot both take the last place", async () => {
    const { rooms } = setup({ membersPerRoom: 2 });
    const { id } = await rooms.create(ana, "Room");
    const { token } = await rooms.invite(ana, id);
    const results = await Promise.allSettled([rooms.accept(ben, token), rooms.accept(cleo, token)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});
