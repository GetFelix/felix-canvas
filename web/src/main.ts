import "@fontsource-variable/inter";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

import {
  EMPTY_DOC,
  TEXT_COLORS,
  TEXT_SHAPES,
  applyInPlace,
  draft,
  freeze,
  inZOrder,
  isBlank,
  stateHash,
  type Doc,
  type TextBlock,
} from "@felix-canvas/model";

import { displayName, signIn, signOut, signedIn, type OidcConfig } from "./auth.js";
import { Chrome, showAccess } from "./chrome.js";
import { Coalescer } from "./coalesce.js";
import { Editor } from "./editor.js";
import { HistoryFeed } from "./history.js";
import { assignColor } from "./members.js";
import { Peers, ownName, personId, saveName } from "./peers.js";
import { render, type Palette } from "./render.js";
import { Scrubber } from "./scrubber.js";
import { RoundTrips, Session } from "./session.js";
import { readShape, type Shape } from "./shapes.js";
import { TextEditor } from "./texteditor.js";
import { BOX_PADDING, fontsLoaded, layout, lineTexts } from "./textlayout.js";

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

/** Fetch from the gateway, retrying until it answers. */
async function fetchJson<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(path);
      if (response.ok) return (await response.json()) as T;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 250 * 2 ** attempt)));
  }
}

const oidc = await fetchJson<OidcConfig>("/oidc");
const switchAccount = () => {
  signOut();
  void signIn(oidc);
};
let token: string | null = null;
let signInError: unknown = null;
try {
  token = await signedIn(oidc);
} catch (error) {
  signInError = error;
}
// Read after signing in: returning from the provider restores the address.
const room = new URLSearchParams(location.search).get("room") || "lobby";
if (signInError) {
  console.warn(`sign-in failed: ${String(signInError)}`);
  showAccess("signed_out", {
    who: "",
    room,
    onSignIn: switchAccount,
    detail: "Signing in didn't finish. Try again.",
  });
  await new Promise(() => {});
}
token ??= await signIn(oidc);

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const session = new Session(gatewayUrl(), { room, token });
const scrubber = new Scrubber(new HistoryFeed(gatewayUrl(), { room, token }));
const person = personId(token);
let name = ownName(person, token);

const NO_TEXT: TextBlock[] = [];

let shapesOf: { doc: Doc; shapes: Shape[] } = { doc: EMPTY_DOC, shapes: [] };
function shapes(): Shape[] {
  const doc = scrubber.doc ?? session.replica.view();
  if (shapesOf.doc !== doc) {
    shapesOf = { doc, shapes: inZOrder(doc).map(([id, state]) => withText(doc, id, state)) };
  }
  return shapesOf.shapes;
}

/** Read a shape and lay out its text. A text box takes its height, and maybe its width, from it. */
function withText(doc: Doc, id: bigint, state: Parameters<typeof readShape>[1]): Shape {
  const shape = readShape(id, state);
  const content = doc.texts.get(id)?.content ?? NO_TEXT;
  if (shape.type === "text") {
    shape.text = layout(content, shape.grows ? Infinity : shape.w);
    if (shape.grows) shape.w = Math.ceil(shape.text.width);
    shape.h = shape.text.height;
  } else if (TEXT_SHAPES.includes(shape.type) && !isBlank(content)) {
    shape.text = layout(content, Math.max(1, Math.abs(shape.w) - BOX_PADDING * 2));
  }
  return shape;
}

const textEditor = new TextEditor(document.getElementById("text-layer")!, canvas, session);
const editor = new Editor(canvas, session, shapes, textEditor);
const peers = new Peers(document.getElementById("cursors")!);
const chrome = new Chrome(session, editor, name, person);
chrome.setAccount(displayName(token), room);
chrome.onSignIn = switchAccount;

let palette = readPalette();
let dirty = true;
const presence = new Coalescer(PRESENCE_GAP_MS, HEARTBEAT_MS);
let joinStartedAt = 0;
/** Milliseconds from starting to join until the first correct frame was drawn. */
let firstFrameMs: number | null = null;
/** Input to the frame that shows its effect, in milliseconds. */
const echoTrips = new RoundTrips();
/** When the newest input not yet shown reached the page. */
let inputAt: number | null = null;
let echoFrom: number | null = null;
for (const type of ["keydown", "pointerdown", "pointermove"]) {
  addEventListener(type, () => (inputAt = performance.now()), { capture: true, passive: true });
}

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
    text: Object.fromEntries(
      TEXT_COLORS.map((name) => [name, token(name === "ink" ? "--ink" : `--text-${name}`)]),
    ),
  };
}

const ownColor = () => assignColor(person, session.members.list());

session.onDocChange = () => {
  editor.prune();
  dirty = true;
};
session.onStatusChange = () => chrome.refresh();
session.onApply = (op) => textEditor.receive(op);
session.onRejoin = (doc) => textEditor.rebase(doc);
textEditor.onTooLong = () => chrome.toast("That's too much text for one box. Try splitting it.");
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
  echoFrom ??= inputAt;
  inputAt = null;
  dirty = true;
  presence.mark();
};
editor.onStateChange = () => {
  chrome.syncEditor();
  presence.mark();
};
chrome.onRename = (newName) => {
  name = newName;
  saveName(person, name);
  membersChanged();
};
scrubber.onChange = () => (dirty = true);
scrubber.onToggle = (active) => {
  editor.setReadOnly(active);
  dirty = true;
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
// The name tags drawn on the canvas need Inter loaded first, and text is
// laid out again once it has.
void document.fonts.ready.then(() => (dirty = true));
void fontsLoaded.then(() => {
  shapesOf = { doc: EMPTY_DOC, shapes: [] };
  dirty = true;
});

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
    const all = shapes();
    const editing = all.find((shape) => shape.id === textEditor.shape);
    if (editing) textEditor.place(editing, editor.camera);
    render(ctx, canvas.clientWidth, canvas.clientHeight, editor.camera, palette, {
      shapes: all,
      editing: textEditor.shape,
      selection: editor.selection,
      hover: editor.hover,
      draft: editor.draft,
      marquee: editor.marquee,
      handles: !editor.dragging,
      peers: scrubber.active
        ? []
        : peers
            .list()
            .filter((peer) => peer.selection.length > 0)
            .map((peer) => ({ name: peer.name, color: peer.color, shapes: peer.selection })),
    });
    dirty = false;
    if (firstFrameMs === null && session.hasFrame) firstFrameMs = now - joinStartedAt;
    session.drawn();
    if (echoFrom !== null) {
      echoTrips.add(performance.now() - echoFrom);
      echoFrom = null;
    }
  }
  if (presence.take(now)) {
    session.publishPresence({
      name,
      color: ownColor(),
      // A pointer over an old picture would mislead whoever sees it.
      cursor: scrubber.active ? null : editor.pointer,
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
    fellBehind: () => session.fellBehind,
    saveTimes: (count: number) => session.editTrips.latest(count),
    ackTimes: (count: number) => session.ackTrips.latest(count),
    echoTimes: (count: number) => echoTrips.latest(count),
    peerEditTimes: (count: number) => session.peerEditTrips.latest(count),
    cursorTimes: (count: number) => session.cursorTrips.latest(count),
    textEchoTimes: (count: number) => textEditor.echoTrips.latest(count),
    text: (id: string) => {
      const text = shapes().find((shape) => shape.id === BigInt(id))?.text;
      return text ? lineTexts(text) : null;
    },
    textHeight: (id: string) =>
      shapes().find((shape) => shape.id === BigInt(id))?.text?.height ?? null,
    layoutMs: (id: string) => {
      const shape = shapes().find((candidate) => candidate.id === BigInt(id))!;
      const content = session.replica.view().texts.get(shape.id)!.content;
      const times: number[] = [];
      for (let i = 0; i < 21; i++) {
        // A width the cache has not seen, so every run lays out afresh.
        const start = performance.now();
        layout(content, shape.w + (i + 1) * 1e-6);
        times.push(performance.now() - start);
      }
      return times.sort((a, b) => a - b)[10]!;
    },
    edit: (id: string) => editor.editText(shapes().find((shape) => shape.id === BigInt(id))!),
    editing: () => textEditor.shape?.toString() ?? null,
    centre: (x: number, y: number) => editor.centre(x, y),
    history: {
      ready: () => scrubber.ready,
      position: () => scrubber.position,
      start: () => scrubber.history?.start ?? 0,
      end: () => scrubber.history?.end ?? 0,
      hash: () => stateHash(scrubber.doc ?? EMPTY_DOC),
      slowestSeekMs: () => scrubber.slowestSeekMs,
      // Folds the held records from the start, without the kept states a seek uses.
      freshHash: (position: number) => {
        const history = scrubber.history!;
        const doc = draft(history.base);
        for (let offset = history.start; offset < position; offset++) {
          const op = history.op(offset);
          if (op) applyInPlace(doc, op, offset);
        }
        return stateHash(freeze(doc));
      },
    },
  },
});

editor.centre(0, 0);
membersChanged();
joinStartedAt = performance.now();
session.start();
requestAnimationFrame(frame);
