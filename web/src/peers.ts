import type { Presence } from "@felix-canvas/model";

import { claims, displayName } from "./auth.js";
import type { Camera } from "./render.js";
import type { RemoteCaret } from "./textcarets.js";

/**
 * The presence palette, in order. Cyan (hue 170 to 210) is left out on
 * purpose: it is Felix's own accent and never a person's.
 */
export const PEER_COLORS = [
  "hsl(4, 82%, 60%)",
  "hsl(26, 92%, 54%)",
  "hsl(42, 95%, 48%)",
  "hsl(142, 58%, 42%)",
  "hsl(222, 84%, 62%)",
  "hsl(262, 72%, 64%)",
  "hsl(312, 68%, 58%)",
  "hsl(344, 78%, 60%)",
];

/** The palette slot for a colour index from the wire, which may be any integer. */
export function paletteIndex(color: number): number {
  const size = PEER_COLORS.length;
  return ((Math.trunc(color) % size) + size) % size;
}

/** Gone if nothing arrives for this long; sessions send a heartbeat every few seconds. */
const EXPIRE_MS = 10_000;
const IDLE_MS = 10_000;
/** Matches the cursor's opacity transition, so a leaving cursor fades out first. */
const FADE_MS = 400;
const NAME_KEY = "felix-canvas.name";
/** Longer names are cut so a cursor's name pill stays small. */
export const MAX_NAME = 24;
/** The spring's angular frequency: settles in about 80 ms. */
const OMEGA = 50;
/** Jumps longer than this on screen snap instead of sweeping across the canvas. */
const SNAP_PX = 800;
/** A typing person's pointer fades after this long, so they show one mark, not two. */
const TYPING_HIDES_POINTER_MS = 1000;

/**
 * The person id for the account `token` signs in: a 64-bit FNV-1a hash of
 * its issuer and subject. Every tab signed in to one account is one person,
 * so it keeps one colour and one entry in the people list.
 */
export function personId(token: string): bigint {
  const { iss, sub } = claims(token) ?? {};
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify([iss, sub]))) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

/** The name this person chose here before, or else the one their account gives. */
export function ownName(person: bigint, token: string): string {
  try {
    const saved = localStorage.getItem(nameKey(person))?.trim().slice(0, MAX_NAME);
    if (saved) return saved;
  } catch {}
  return displayName(token).slice(0, MAX_NAME) || "Guest";
}

/** Keep `name` for this person's next visits. */
export function saveName(person: bigint, name: string): void {
  try {
    localStorage.setItem(nameKey(person), name);
  } catch {
    // Private windows may refuse storage; the name still applies to this visit.
  }
}

function nameKey(person: bigint): string {
  return `${NAME_KEY}.${person.toString(16).padStart(16, "0")}`;
}

/** Another session in the room, as its presence messages describe it. */
export interface Peer {
  sid: bigint;
  name: string;
  color: string;
  colorIndex: number;
  selection: bigint[];
  idle: boolean;
  /** When the pointer last moved, on the `performance.now()` clock. */
  lastMove: number;
  /** Their caret in the text they are editing, if they are. */
  caret: RemoteCaret | null;
}

interface Tracked extends Peer {
  target: { x: number; y: number } | null;
  shown: { x: number; y: number };
  velocity: { x: number; y: number };
  lastSeen: number;
  /** When they started typing without moving the pointer since, if they have. */
  typingSince: number | null;
  element: HTMLElement;
}

/**
 * Remote cursors over the canvas. Positions are eased toward each message
 * with a critically damped spring and drawn with transforms, never layout.
 */
export class Peers {
  readonly #layer: HTMLElement;
  readonly #peers = new Map<bigint, Tracked>();

  constructor(layer: HTMLElement) {
    this.#layer = layer;
  }

  list(): Peer[] {
    return [...this.#peers.values()];
  }

  /** Take one message. Returns whether the set of peers or their selections changed. */
  update(presence: Presence, now = performance.now()): boolean {
    const existing = this.#peers.get(presence.sid);
    if (presence.gone) {
      if (existing) this.#remove(existing);
      return existing !== undefined;
    }
    const colorIndex = paletteIndex(presence.color);
    const color = PEER_COLORS[colorIndex]!;
    const peer = existing ?? this.#add(presence, color, now);
    let changed =
      !existing ||
      peer.name !== presence.name ||
      peer.colorIndex !== colorIndex ||
      peer.selection.join() !== presence.selection.join();
    peer.name = presence.name;
    peer.color = color;
    peer.colorIndex = colorIndex;
    peer.selection = presence.selection;
    peer.lastSeen = now;
    const moved =
      presence.cursor &&
      (!peer.target || peer.target.x !== presence.cursor.x || peer.target.y !== presence.cursor.y);
    if (moved) {
      peer.lastMove = now;
      peer.typingSince = null;
    }
    peer.target = presence.cursor;
    const caret = this.#caret(peer, presence, now);
    if (caret !== peer.caret) {
      peer.caret = caret;
      if (caret) peer.typingSince ??= now;
      changed = true;
    }
    peer.element.style.setProperty("--peer", color);
    peer.element.querySelector(".cursor-name")!.textContent = presence.name;
    return changed;
  }

  /**
   * Advance the springs by `dt` seconds and place every cursor. Returns
   * whether any is still moving, and whether the peer list changed.
   */
  tick(dt: number, camera: Camera, now = performance.now()): { moving: boolean; changed: boolean } {
    let moving = false;
    let changed = false;
    for (const peer of this.#peers.values()) {
      if (now - peer.lastSeen > EXPIRE_MS) {
        this.#remove(peer);
        changed = true;
        continue;
      }
      const idle = now - peer.lastMove > IDLE_MS;
      if (idle !== peer.idle) {
        peer.idle = idle;
        changed = true;
      }
      const target = peer.target;
      const typing = peer.typingSince !== null && now - peer.typingSince > TYPING_HIDES_POINTER_MS;
      peer.element.classList.toggle("hidden", target === null || typing);
      peer.element.classList.toggle("idle", idle);
      if (!target) continue;
      const jump = Math.hypot(target.x - peer.shown.x, target.y - peer.shown.y) * camera.zoom;
      if (jump > SNAP_PX || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        peer.shown = { ...target };
        peer.velocity = { x: 0, y: 0 };
      } else {
        for (const axis of ["x", "y"] as const) {
          [peer.shown[axis], peer.velocity[axis]] = spring(
            peer.shown[axis],
            peer.velocity[axis],
            target[axis],
            dt,
          );
        }
        if (jump > 0.05 || Math.hypot(peer.velocity.x, peer.velocity.y) > 0.5) moving = true;
      }
      const x = (peer.shown.x - camera.x) * camera.zoom;
      const y = (peer.shown.y - camera.y) * camera.zoom;
      peer.element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
    return { moving, changed };
  }

  #add(presence: Presence, color: string, now: number): Tracked {
    const element = document.createElement("div");
    element.className = "cursor hidden";
    element.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="M1.5 1.2 L14 7.1 L8.3 8.4 L5.6 14.2 Z" /></svg><span class="cursor-name"></span>';
    this.#layer.append(element);
    const start = presence.cursor ?? { x: 0, y: 0 };
    const peer: Tracked = {
      sid: presence.sid,
      name: presence.name,
      color,
      colorIndex: presence.color,
      selection: presence.selection,
      idle: false,
      target: presence.cursor,
      shown: { ...start },
      velocity: { x: 0, y: 0 },
      lastMove: now,
      lastSeen: now,
      caret: null,
      typingSince: null,
      element,
    };
    this.#peers.set(presence.sid, peer);
    return peer;
  }

  /**
   * Note that `sid` typed into the text its caret is in. A caret at the end
   * of a text points at the end, which does not change as they type there,
   * so this is what keeps their name showing. Returns whether a caret changed.
   */
  typed(sid: bigint, shape: bigint, now = performance.now()): boolean {
    const peer = this.#peers.get(sid);
    if (peer?.caret?.shape !== shape) return false;
    peer.caret = { ...peer.caret, movedAt: now };
    peer.typingSince ??= now;
    return true;
  }

  /** The peer's caret: the one it has while nothing about it changed, so it can be cached. */
  #caret(peer: Tracked, presence: Presence, now: number): RemoteCaret | null {
    const text = presence.text;
    if (!text) return null;
    const old = peer.caret;
    if (
      old &&
      old.shape === text.shape &&
      old.name === peer.name &&
      old.color === peer.color &&
      sameBytes(old.anchor, text.anchor) &&
      sameBytes(old.head, text.head)
    ) {
      return old;
    }
    return { sid: peer.sid, name: peer.name, color: peer.color, ...text, movedAt: now };
  }

  #remove(peer: Tracked): void {
    peer.element.classList.add("hidden");
    setTimeout(() => peer.element.remove(), FADE_MS);
    this.#peers.delete(peer.sid);
  }
}

/** One step of a critically damped spring, solved exactly so any `dt` is stable. */
function spring(x: number, v: number, target: number, dt: number): [number, number] {
  const decay = Math.exp(-OMEGA * dt);
  const c1 = x - target;
  const c2 = v + OMEGA * c1;
  return [target + (c1 + c2 * dt) * decay, (c2 - OMEGA * (c1 + c2 * dt)) * decay];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
