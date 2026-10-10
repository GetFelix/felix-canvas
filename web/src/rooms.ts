// The rooms service's API, which the page reaches on its own origin under
// /api/. A deployment without the service answers /api/health with the page
// or a 404, and the page then keeps to operator-made rooms.

export interface RoomSummary {
  id: string;
  title: string;
  owner: boolean;
  members: number;
}

export interface RoomList {
  rooms: RoomSummary[];
  /** How many rooms this person owns, and may own. */
  owned: number;
  limit: number;
}

export interface RoomView {
  id: string;
  title: string;
  owner: boolean;
  ownerName: string;
  members: { id: string; name: string; owner: boolean; you: boolean }[];
  /** Open invite links; only the owner gets any. */
  invites: { id: string; token: string; expires: number }[];
  limits: { members: number; invites: number };
}

export interface InvitePreview {
  room: string;
  title: string;
  ownerName: string;
  member: boolean;
  expires: number;
}

/** A refusal from the service, with its message in words a person can read. */
export class RoomsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class RoomsApi {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  /** Whether this deployment runs the rooms service. */
  static async available(): Promise<boolean> {
    try {
      const response = await fetch("/api/health");
      return response.ok && Boolean(response.headers.get("content-type")?.includes("json"));
    } catch {
      return false;
    }
  }

  list(): Promise<RoomList> {
    return this.#call("GET", "/api/rooms");
  }

  create(title: string): Promise<RoomView> {
    return this.#call("POST", "/api/rooms", { title });
  }

  /** The room, or `null` when it is not one of this person's self-service rooms. */
  async get(room: string): Promise<RoomView | null> {
    try {
      return await this.#call<RoomView>("GET", `/api/rooms/${encodeURIComponent(room)}`);
    } catch (err) {
      if (err instanceof RoomsError && err.status === 404) return null;
      throw err;
    }
  }

  delete(room: string): Promise<void> {
    return this.#call("DELETE", `/api/rooms/${encodeURIComponent(room)}`);
  }

  invite(room: string): Promise<{ id: string; token: string; expires: number }> {
    return this.#call("POST", `/api/rooms/${encodeURIComponent(room)}/invites`);
  }

  revokeInvite(room: string, invite: string): Promise<void> {
    return this.#call(
      "DELETE",
      `/api/rooms/${encodeURIComponent(room)}/invites/${encodeURIComponent(invite)}`,
    );
  }

  /** Take someone out of a room; `"me"` leaves it. */
  removeMember(room: string, member: string): Promise<void> {
    return this.#call(
      "DELETE",
      `/api/rooms/${encodeURIComponent(room)}/members/${encodeURIComponent(member)}`,
    );
  }

  preview(invite: string): Promise<InvitePreview> {
    return this.#call("GET", `/api/invites/${encodeURIComponent(invite)}`);
  }

  accept(invite: string): Promise<RoomView> {
    return this.#call("POST", `/api/invites/${encodeURIComponent(invite)}`);
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new RoomsError(0, "unavailable", "Can't reach the server. Try again soon.");
    }
    const answer: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const refusal = answer as { error?: string; message?: string };
      throw new RoomsError(
        response.status,
        refusal.error ?? "unavailable",
        refusal.message ?? "Something went wrong. Try again soon.",
      );
    }
    return answer as T;
  }
}

/** The address that opens the invite page for `token`. */
export function inviteLink(token: string): string {
  return `${location.origin}/?invite=${encodeURIComponent(token)}`;
}

/** The address of a room on this page. */
export function roomLink(room: string): string {
  return `${location.origin}/?room=${encodeURIComponent(room)}`;
}

/** "in 6 days", "in 5 hours", "in a few minutes": when an invite stops working. */
export function expiresIn(expires: number, now = Date.now()): string {
  const hours = (expires - now) / 3_600_000;
  if (hours >= 47.5) return `in ${Math.round(hours / 24)} days`;
  if (hours >= 1.5) return `in ${Math.round(hours)} hours`;
  if (hours >= 0.75) return "in an hour";
  return "in a few minutes";
}
