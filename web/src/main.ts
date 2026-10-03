import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

import { EMPTY_DOC, inZOrder, stateHash, type Doc } from "@felix-canvas/model";

import { Chrome } from "./chrome.js";
import { Coalescer } from "./coalesce.js";
import { Editor } from "./editor.js";
import { assignColor } from "./members.js";
import { Peers, ownName, ownPersonId, saveName } from "./peers.js";
import { render, type Palette } from "./render.js";
import { Session } from "./session.js";
import { readShape, type Shape } from "./shapes.js";

/** Idle sessions still announce themselves this often, so peers know they are here. */
const HEARTBEAT_MS = 3000;
/** At most one presence message a frame, and no more than 60 a second on faster screens. */
const PRESENCE_GAP_MS = 16;

function gatewayUrl(): string {
  const override = new URLSearchParams(location.search).get("gateway");
  if (override) return override;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const session = new Session(gatewayUrl());
let name = ownName();
const person = ownPersonId();

let shapesOf: { doc: Doc; shapes: Shape[] } = { doc: EMPTY_DOC, shapes: [] };
function shapes(): Shape[] {
  const doc = session.replica.view();
  if (shapesOf.doc !== doc) {
    shapesOf = { doc, shapes: inZOrder(doc).map(([id, state]) => readShape(id, state)) };
  }
  return shapesOf.shapes;
}

const editor = new Editor(canvas, session, shapes);
const peers = new Peers(document.getElementById("cursors")!);
const chrome = new Chrome(session, editor, name, person);

let palette = readPalette();
let dirty = true;
const presence = new Coalescer(PRESENCE_GAP_MS, HEARTBEAT_MS);
let joinStartedAt = 0;
/** Milliseconds from starting to join until the first correct frame was drawn. */
let firstFrameMs: number | null = null;

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const token = (property: string) => style.getPropertyValue(property).trim();
  return {
    canvas: token("--canvas"),
    dot: token("--canvas-dot"),
    ink: token("--ink"),
    fill: token("--shape-fill"),
    accent: token("--accent"),
    accentSoft: token("--accent-soft"),
    handle: token("--handle"),
  };
}

const ownColor = () => assignColor(person, session.members.list());

session.onDocChange = () => {
  editor.prune();
  dirty = true;
};
session.onStatusChange = () => chrome.refresh();
session.onPresence = (message) => {
  if (peers.update(message)) {
    chrome.setPeers(peers.list());
    dirty = true;
  }
};
// Own colour depends on who else is here, and the entry carries it.
function membersChanged(): void {
  const color = ownColor();
  session.setMember({ name, color, person });
  chrome.setMembers(session.members.list(), color);
  presence.mark();
}
session.onMembersChange = membersChanged;
editor.onChange = () => {
  dirty = true;
  presence.mark();
};
editor.onStateChange = () => {
  chrome.syncEditor();
  presence.mark();
};
chrome.onRename = (newName) => {
  name = newName;
  saveName(name);
  membersChanged();
};
editor.onRefused = () => chrome.toast("Offline for too long: reconnect to keep editing");
chrome.onThemeChange = () => {
  palette = readPalette();
  dirty = true;
};

new ResizeObserver(() => {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  dirty = true;
}).observe(canvas);
// The name tags drawn on the canvas need Inter loaded first.
void document.fonts.ready.then(() => (dirty = true));

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const { moving, changed } = peers.tick(dt, editor.camera, now);
  if (changed) {
    chrome.setPeers(peers.list());
    dirty = true;
  }
  if (dirty || moving) {
    render(ctx, canvas.clientWidth, canvas.clientHeight, editor.camera, palette, {
      shapes: shapes(),
      selection: editor.selection,
      hover: editor.hover,
      draft: editor.draft,
      marquee: editor.marquee,
      handles: !editor.dragging,
      peers: peers
        .list()
        .filter((peer) => peer.selection.length > 0)
        .map((peer) => ({ name: peer.name, color: peer.color, shapes: peer.selection })),
    });
    dirty = false;
    if (firstFrameMs === null && session.hasFrame) firstFrameMs = now - joinStartedAt;
  }
  if (presence.take(now)) {
    session.publishPresence({
      name,
      color: ownColor(),
      cursor: editor.pointer,
      selection: [...editor.selection],
    });
  }
  requestAnimationFrame(frame);
}

addEventListener("pagehide", () => {
  session.leave();
  session.publishPresence({ name, color: ownColor(), cursor: null, selection: [], gone: true });
});
// A tab restored from the back-forward cache comes back after its goodbye.
addEventListener("pageshow", (event) => {
  if (event.persisted) membersChanged();
});
setInterval(() => session.expireMembers(), 250);

// The end-to-end tests compare replicas across browsers through this.
Object.assign(window, {
  felixCanvas: {
    hash: () => stateHash(session.replica.confirmed),
    applied: () => session.replica.next,
    pending: () => session.replica.pending.length,
    shapes: () => shapes().length,
    firstFrameMs: () => firstFrameMs,
    snapshotOffset: () => session.snapshotOffset,
  },
});

editor.centre(0, 0);
membersChanged();
joinStartedAt = performance.now();
session.start();
requestAnimationFrame(frame);
