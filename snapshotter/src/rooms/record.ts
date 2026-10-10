// What the rooms service keeps about each room it created, one key per room
// in a Felix cache. The snapshotter watches the same cache to learn which
// rooms to fold.

/** The cache holding one record per self-service room, keyed by room id. */
export const REGISTRY_CACHE = "canvas.rooms";

/** Someone who may open a room, keyed in {@link RoomRecord.members} by Felix principal. */
export interface Member {
  /** The name their sign-in gave when they joined. */
  name: string;
  /** Unix milliseconds. */
  joined: number;
}

/** An invite link that has not been revoked, keyed by its id. */
export interface Invite {
  created: number;
  expires: number;
}

export interface RoomRecord {
  id: string;
  title: string;
  created: number;
  /** The owner's Felix principal. The owner is also in `members`. */
  owner: string;
  members: Record<string, Member>;
  invites: Record<string, Invite>;
}

export function encodeRecord(record: RoomRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

/** The record in `bytes`, or `null` if they do not hold one. */
export function decodeRecord(bytes: Uint8Array): RoomRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<RoomRecord>;
  const valid =
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.created === "number" &&
    typeof record.owner === "string" &&
    typeof record.members === "object" &&
    record.members !== null &&
    typeof record.invites === "object" &&
    record.invites !== null;
  return valid ? (record as RoomRecord) : null;
}
