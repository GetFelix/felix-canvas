import { decodeMember, type Member } from "@felix-canvas/model";

import { PEER_COLORS, paletteIndex } from "./peers.js";

/** Someone in the room, as their member entry describes them. */
export interface RoomMember extends Member {
  sid: bigint;
}

/** A member entry as the gateway reports it. */
export interface MemberEntry {
  /** The session id as 16 hex digits. */
  key: string;
  /** The encoded {@link Member}, or `null` when the entry was deleted. */
  payload: Uint8Array | null;
  /** Milliseconds until the entry expires, or `null` if it never does. */
  expiresInMs: number | null;
}

/** The member key for a session: its id as 16 hex digits. */
export function memberKey(sid: bigint): string {
  return sid.toString(16).padStart(16, "0");
}

/**
 * Who is in the room. Each entry is kept until its own deadline: Felix sends
 * nothing when an entry expires, so the deadline the gateway reports with
 * each write is the only notice a watcher gets.
 */
export class Members {
  readonly #entries = new Map<bigint, { member: RoomMember; expiresAt: number }>();

  /** Replace every entry with the full list a new watch starts with. */
  reset(entries: MemberEntry[], now: number): void {
    this.#entries.clear();
    for (const entry of entries) this.apply(entry, now);
  }

  /** Apply one write or delete. Returns whether the list changed. */
  apply(entry: MemberEntry, now: number): boolean {
    if (!/^[0-9a-f]{16}$/.test(entry.key)) return false;
    const sid = BigInt(`0x${entry.key}`);
    const existing = this.#entries.get(sid);
    if (entry.payload === null) return this.#entries.delete(sid);
    let member: Member;
    try {
      member = decodeMember(entry.payload);
    } catch {
      return false;
    }
    const expiresAt = entry.expiresInMs === null ? Infinity : now + entry.expiresInMs;
    this.#entries.set(sid, { member: { sid, ...member }, expiresAt });
    return (
      !existing || existing.member.name !== member.name || existing.member.color !== member.color
    );
  }

  /** Drop entries past their deadline. Returns whether any were dropped. */
  expire(now: number): boolean {
    let changed = false;
    for (const [sid, entry] of this.#entries) {
      if (entry.expiresAt <= now) changed = this.#entries.delete(sid);
    }
    return changed;
  }

  /** Everyone in the room, in the order they arrived. */
  list(): RoomMember[] {
    return [...this.#entries.values()].map((entry) => entry.member);
  }
}

/**
 * The palette index for session `sid`: its hash, moved on to the next free
 * colour while a member with a smaller id holds it. Every client sees the
 * same members, so they settle on the same assignment.
 */
export function assignColor(sid: bigint, members: readonly RoomMember[]): number {
  const size = PEER_COLORS.length;
  const taken = new Set(
    members.filter((member) => member.sid < sid).map((member) => paletteIndex(member.color)),
  );
  let index = Number(sid % BigInt(size));
  for (let i = 0; i < size && taken.has(index); i++) index = (index + 1) % size;
  return index;
}
