import { randomBytes } from "node:crypto";

import type { Identity } from "./idtoken.js";
import { readInvite, signInvite } from "./invite.js";
import type { RoomRecord } from "./record.js";

/** What a room needs in Felix besides its record. */
export interface Provisioner {
  /** Create the room's streams, caches and role, and give `owner` the role. */
  create(room: string, owner: string): Promise<void>;
  /** Take the role from everyone in `members`, then remove the role, streams and caches. */
  destroy(room: string, members: string[]): Promise<void>;
  grant(room: string, principal: string): Promise<void>;
  revoke(room: string, principal: string): Promise<void>;
}

/** Where room records are kept. */
export interface Registry {
  put(record: RoomRecord): Promise<void>;
  delete(room: string): Promise<void>;
}

export interface Limits {
  /** Rooms one person may own at once. */
  roomsPerUser: number;
  /** People in a room, its owner included. */
  membersPerRoom: number;
  /** Invite links a room may have open at once. */
  invitesPerRoom: number;
  /** How long an invite link works, in milliseconds. */
  inviteTtlMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  roomsPerUser: 5,
  membersPerRoom: 20,
  invitesPerRoom: 10,
  inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
};

type InviteRefusal = "invite_expired" | "invite_invalid";
export type RoomsErrorCode = "invalid" | "not_found" | "forbidden" | "limit" | InviteRefusal;

/** A refusal the HTTP layer turns into a status and a JSON body. */
export class RoomsError extends Error {
  readonly code: RoomsErrorCode;

  constructor(code: RoomsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A room in someone's list. */
export interface RoomSummary {
  id: string;
  title: string;
  owner: boolean;
  members: number;
}

/** A room as one of its members sees it. Only the owner sees invites. */
export interface RoomView {
  id: string;
  title: string;
  owner: boolean;
  ownerName: string;
  members: { id: string; name: string; owner: boolean; you: boolean }[];
  /** With the token, so the owner can copy a link again at any time. */
  invites: { id: string; token: string; expires: number }[];
  limits: { members: number; invites: number };
}

export interface InviteView {
  id: string;
  token: string;
  expires: number;
}

export interface InvitePreview {
  room: string;
  title: string;
  ownerName: string;
  /** Whether the caller can already open the room. */
  member: boolean;
  expires: number;
}

/** 1 to 60 characters once trimmed, no control characters. */
const MAX_TITLE = 60;
const ROOM_ID_LENGTH = 12;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export interface RoomsOptions {
  provisioner: Provisioner;
  registry: Registry;
  /** Every record the registry holds at start. */
  records: RoomRecord[];
  /** The key invite links are signed with. */
  secret: string;
  limits?: Limits;
  now?: () => number;
  /** A new room id; random unless a test fixes it. */
  newRoomId?: () => string;
}

/**
 * Self-service rooms: create, invite, join, remove, delete. The service is
 * the registry's only writer, so it keeps every record in memory and runs one
 * change at a time; a change reaches Felix before the record that describes
 * it, so a crash leaves at most something unused in Felix, never a record
 * pointing at nothing.
 */
export class Rooms {
  readonly #provisioner: Provisioner;
  readonly #registry: Registry;
  readonly #secret: string;
  readonly #limits: Limits;
  readonly #now: () => number;
  readonly #newRoomId: () => string;
  readonly #records = new Map<string, RoomRecord>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: RoomsOptions) {
    this.#provisioner = options.provisioner;
    this.#registry = options.registry;
    this.#secret = options.secret;
    this.#limits = options.limits ?? DEFAULT_LIMITS;
    this.#now = options.now ?? Date.now;
    this.#newRoomId = options.newRoomId ?? newRoomId;
    for (const record of options.records) this.#records.set(record.id, record);
  }

  get limits(): Limits {
    return this.#limits;
  }

  /** The rooms `who` may open, newest first. */
  list(who: Identity): RoomSummary[] {
    return [...this.#records.values()]
      .filter((record) => Object.hasOwn(record.members, who.principal))
      .sort((a, b) => b.created - a.created)
      .map((record) => ({
        id: record.id,
        title: record.title,
        owner: record.owner === who.principal,
        members: Object.keys(record.members).length,
      }));
  }

  /** How many rooms `who` owns. */
  owned(who: Identity): number {
    return [...this.#records.values()].filter((record) => record.owner === who.principal).length;
  }

  /** A room `who` is in. Anyone else gets `not_found`, so ids reveal nothing. */
  get(who: Identity, room: string): RoomView {
    return this.#view(who, this.#memberOf(who, room));
  }

  create(who: Identity, title: unknown): Promise<RoomView> {
    return this.#serially(async () => {
      const clean = cleanTitle(title);
      if (this.owned(who) >= this.#limits.roomsPerUser) {
        throw new RoomsError("limit", `You can own up to ${this.#limits.roomsPerUser} rooms.`);
      }
      let id = this.#newRoomId();
      while (this.#records.has(id)) id = this.#newRoomId();
      const now = this.#now();
      const record: RoomRecord = {
        id,
        title: clean,
        created: now,
        owner: who.principal,
        members: { [who.principal]: { name: who.name, joined: now } },
        invites: {},
      };
      try {
        await this.#provisioner.create(id, who.principal);
        await this.#registry.put(record);
      } catch (err) {
        await this.#provisioner.destroy(id, [who.principal]).catch(() => {});
        throw err;
      }
      this.#records.set(id, record);
      return this.#view(who, record);
    });
  }

  /** Delete a room and everything in it. Owner only. */
  delete(who: Identity, room: string): Promise<void> {
    return this.#serially(async () => {
      const record = this.#ownedBy(who, room);
      // The record goes first, so the room stops being listed and folded even
      // if taking it apart in Felix fails halfway.
      await this.#registry.delete(room);
      this.#records.delete(room);
      await this.#provisioner.destroy(room, Object.keys(record.members)).catch((err: unknown) => {
        // The room is already gone from every list; the rest is the operator's to tidy.
        console.error(`rooms: deleting ${room} in Felix: ${String(err)}`);
      });
    });
  }

  /** A new invite link for a room. Owner only. */
  invite(who: Identity, room: string): Promise<InviteView> {
    return this.#serially(async () => {
      const record = this.#ownedBy(who, room);
      const now = this.#now();
      const invites = live(record.invites, now);
      if (Object.keys(invites).length >= this.#limits.invitesPerRoom) {
        throw new RoomsError(
          "limit",
          `A room can have ${this.#limits.invitesPerRoom} invite links at once. Revoke one first.`,
        );
      }
      const id = randomBytes(9).toString("base64url");
      const expires = now + this.#limits.inviteTtlMs;
      invites[id] = { created: now, expires };
      await this.#save({ ...record, invites });
      return { id, token: signInvite(this.#secret, { room, id, expires }), expires };
    });
  }

  /** Stop an invite link working. Owner only. */
  revokeInvite(who: Identity, room: string, invite: string): Promise<void> {
    return this.#serially(async () => {
      const record = this.#ownedBy(who, room);
      const invites = live(record.invites, this.#now());
      if (!Object.hasOwn(invites, invite))
        throw new RoomsError("not_found", "No such invite link.");
      delete invites[invite];
      await this.#save({ ...record, invites });
    });
  }

  /** What an invite link leads to, for the page that asks whether to join. */
  preview(who: Identity, token: string): InvitePreview {
    const { record, expires } = this.#redeemable(token);
    return {
      room: record.id,
      title: record.title,
      ownerName: record.members[record.owner]?.name ?? "",
      member: Object.hasOwn(record.members, who.principal),
      expires,
    };
  }

  /** Join the room an invite link is for. Joining a room you are in already changes nothing. */
  accept(who: Identity, token: string): Promise<RoomView> {
    return this.#serially(async () => {
      const { record } = this.#redeemable(token);
      if (Object.hasOwn(record.members, who.principal)) return this.#view(who, record);
      if (Object.keys(record.members).length >= this.#limits.membersPerRoom) {
        throw new RoomsError(
          "limit",
          `This room is full: it can have ${this.#limits.membersPerRoom} people.`,
        );
      }
      await this.#provisioner.grant(record.id, who.principal);
      const members = {
        ...record.members,
        [who.principal]: { name: who.name, joined: this.#now() },
      };
      return this.#view(who, await this.#save({ ...record, members }));
    });
  }

  /**
   * Take someone out of a room. The owner may remove anyone but themselves;
   * anyone else may only remove themselves, which is leaving.
   */
  removeMember(who: Identity, room: string, member: string): Promise<void> {
    return this.#serially(async () => {
      const record = this.#memberOf(who, room);
      const target = member === "me" ? who.principal : member;
      if (target === record.owner) {
        throw new RoomsError("invalid", "The owner can't leave their own room. Delete it instead.");
      }
      if (record.owner !== who.principal && target !== who.principal) {
        throw new RoomsError("forbidden", "Only the room's owner can remove people.");
      }
      if (!Object.hasOwn(record.members, target))
        throw new RoomsError("not_found", "No such person here.");
      await this.#provisioner.revoke(room, target);
      const members = { ...record.members };
      delete members[target];
      await this.#save({ ...record, members });
    });
  }

  #redeemable(token: string): { record: RoomRecord; expires: number } {
    const claims = readInvite(this.#secret, token);
    if (!claims) throw new RoomsError("invite_invalid", "This invite link isn't valid.");
    const record = this.#records.get(claims.room);
    const invite =
      record && Object.hasOwn(record.invites, claims.id) ? record.invites[claims.id] : undefined;
    if (!record || !invite) {
      throw new RoomsError("invite_invalid", "This invite link no longer works.");
    }
    if (Math.min(claims.expires, invite.expires) <= this.#now()) {
      throw new RoomsError("invite_expired", "This invite link has expired.");
    }
    return { record, expires: invite.expires };
  }

  #memberOf(who: Identity, room: string): RoomRecord {
    const record = this.#records.get(room);
    if (!record || !Object.hasOwn(record.members, who.principal)) {
      throw new RoomsError("not_found", "No such room.");
    }
    return record;
  }

  #ownedBy(who: Identity, room: string): RoomRecord {
    const record = this.#memberOf(who, room);
    if (record.owner !== who.principal) {
      throw new RoomsError("forbidden", "Only the room's owner can do that.");
    }
    return record;
  }

  async #save(record: RoomRecord): Promise<RoomRecord> {
    await this.#registry.put(record);
    this.#records.set(record.id, record);
    return record;
  }

  #view(who: Identity, record: RoomRecord): RoomView {
    const owner = record.owner === who.principal;
    return {
      id: record.id,
      title: record.title,
      owner,
      ownerName: record.members[record.owner]?.name ?? "",
      members: Object.entries(record.members)
        .sort(([a, x], [b, y]) =>
          a === record.owner ? -1 : b === record.owner ? 1 : x.joined - y.joined,
        )
        .map(([id, member]) => ({
          id,
          name: member.name,
          owner: id === record.owner,
          you: id === who.principal,
        })),
      invites: owner
        ? Object.entries(live(record.invites, this.#now()))
            .map(([id, invite]) => ({
              id,
              token: signInvite(this.#secret, { room: record.id, id, expires: invite.expires }),
              expires: invite.expires,
            }))
            .sort((a, b) => a.expires - b.expires)
        : [],
      limits: { members: this.#limits.membersPerRoom, invites: this.#limits.invitesPerRoom },
    };
  }

  /** Run changes one at a time, so checks and the writes they guard never interleave. */
  #serially<T>(change: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(change, change);
    this.#queue = next.catch(() => {});
    return next;
  }
}

/** Invites that have not expired, as a fresh object. */
function live(invites: RoomRecord["invites"], now: number): RoomRecord["invites"] {
  return Object.fromEntries(Object.entries(invites).filter(([, invite]) => invite.expires > now));
}

function cleanTitle(title: unknown): string {
  const clean = typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
  if (!clean || [...clean].length > MAX_TITLE || /[\u0000-\u001f\u007f-\u009f]/.test(clean)) {
    throw new RoomsError("invalid", `A room name is 1 to ${MAX_TITLE} characters.`);
  }
  return clean;
}

/** `r` and lower-case letters and digits, which the gateway accepts as a room and Felix in a name. */
export function newRoomId(): string {
  const bytes = randomBytes(ROOM_ID_LENGTH - 1);
  return `r${[...bytes].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("")}`;
}
