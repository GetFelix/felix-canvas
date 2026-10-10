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
import { RoomPanels, showInvite } from "./roompanels.js";
import { RoomsApi } from "./rooms.js";
import { RoundTrips, Session } from "./session.js";
import { bounds, readShape, type Shape } from "./shapes.js";
import { TextBar, wholeFormats, type TextTarget } from "./textbar.js";
import { CaretPlaces, FLAG_MS, type RemoteCaret } from "./textcarets.js";
import { TextEditor } from "./texteditor.js";
import { BOX_PADDING, fontsLoaded, layout, lineTexts } from "./textlayout.js";

/** Idle sessions still announce themselves this often, so peers know they are here. */
const HEARTBEAT_MS = 3000;
/**
 * At most 25 presence messages a second. Peers ease cursors between them, and
 * the gateway's per-session write rate (50 a second) must also fit the ops.
 */
const PRESENCE_GAP_MS = 40;

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
const rooms = new RoomsApi(token);
// An invite link opens a page that asks whether to join, not a room.
const invite = new URLSearchParams(location.search).get("invite");
if (invite) await showInvite(rooms, invite, { who: displayName(token), onSignIn: switchAccount });

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
const textBar = new TextBar();
const caretPlaces = new CaretPlaces();
let editorCarets: RemoteCaret[] = [];
/** Other people's carets the canvas drew last, for the end-to-end tests. */
let canvasCarets: { name: string; block: number; offset: number }[] = [];
const linkTip = document.getElementById("link-tip")!;
const peers = new Peers(document.getElementById("cursors")!);
const chrome = new Chrome(session, editor, name, person);
chrome.setAccount(displayName(token), room);
chrome.onSignIn = switchAccount;
void new RoomPanels(rooms, chrome, room).start();

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
    selectionAlpha: Number(token("--remote-selection-alpha")) || 0.2,
    text: Object.fromEntries(
      TEXT_COLORS.map((name) => [name, token(name === "ink" ? "--ink" : `--text-${name}`)]),
    ),
  };
}

const ownColor = () => assignColor(person, session.members.list());

// Pruned once a frame: pruning reads the view, which freezes the replica
// and lays out changed text, and catching up delivers thousands of changes
// between frames.
let pruneDue = false;
session.onDocChange = () => {
  pruneDue = true;
  dirty = true;
};
session.onStatusChange = () => chrome.refresh();
session.onApply = (op) => {
  textEditor.receive(op);
  if (op.kind === "text" && peers.typed(op.sid, op.shape)) dirty = true;
};
session.onRejoin = (doc) => textEditor.rebase(doc);
textEditor.onTooLong = () => chrome.toast("That's too much text for one box. Try splitting it.");
textEditor.onSelectionChange = () => {
  dirty = true;
  presence.mark();
};
textEditor.onLink = () => textBar.openLink();
textEditor.onLinkHover = (link) => textBar.showLinkHover(link);
textBar.onDone = () => textEditor.focus();
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
  if (pruneDue) {
    pruneDue = false;
    editor.prune();
  }
  if (dirty || moving) {
    const all = shapes();
    const editing = all.find((shape) => shape.id === textEditor.shape);
    if (editing) textEditor.place(editing, editor.camera);
    const carets = scrubber.active
      ? []
      : peers.list().flatMap(({ caret }) => (caret ? [caret] : []));
    showEditorCarets(carets.filter((caret) => caret.shape === textEditor.shape));
    textEditor.drawCarets(now);
    const placed = carets.flatMap((caret) => {
      const body = session.replica.view().texts.get(caret.shape);
      const at = body && caret.shape !== textEditor.shape && caretPlaces.place(caret, body);
      return at ? [{ ...at, shape: caret.shape }] : [];
    });
    canvasCarets = placed.map(({ caret, head }) => ({ name: caret.name, ...head }));
    render(ctx, canvas.clientWidth, canvas.clientHeight, editor.camera, palette, {
      shapes: all,
      editing: textEditor.shape,
      carets: placed,
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
            .map((peer) => ({
              name: peer.name,
              color: peer.color,
              shapes: peer.selection,
              editing: peer.caret?.shape ?? null,
            })),
    });
    textBar.show(textTarget(all));
    showLinkTip();
    // Keep drawing while a caret's name flag is showing, so it shrinks on time.
    dirty = carets.some((caret) => now - caret.movedAt < FLAG_MS + 200);
    if (firstFrameMs === null && session.hasFrame) firstFrameMs = now - joinStartedAt;
    session.drawn();
    if (echoFrom !== null) {
      echoTrips.add(performance.now() - echoFrom);
      echoFrom = null;
    }
  }
  if (presence.take(now)) {
    const text = textEditor.selection();
    session.publishPresence({
      name,
      color: ownColor(),
      // A pointer over an old picture would mislead whoever sees it.
      cursor: scrubber.active ? null : editor.pointer,
      selection: [...editor.selection],
      ...(text ? { text } : {}),
    });
  }
  requestAnimationFrame(frame);
}

/** What the text bar formats now, if anything. */
function textTarget(all: Shape[]): TextTarget | null {
  if (scrubber.active || editor.dragging) return null;
  const tagged = (id: bigint) => peers.list().some((peer) => peer.selection.includes(id));
  const open = all.find((shape) => shape.id === textEditor.shape);
  const formats = textEditor.formats();
  if (open && formats) {
    return {
      shape: open,
      box: textEditor.box()!,
      formats,
      tagged: tagged(open.id),
      run: (command) => textEditor.run(command),
    };
  }
  const [id] = editor.selection;
  const shape =
    editor.selection.size === 1 ? all.find((candidate) => candidate.id === id) : undefined;
  const content = shape && session.replica.view().texts.get(shape.id)?.content;
  if (!shape || !content || isBlank(content)) return null;
  const { x, y, w, h } = bounds(shape);
  const { camera } = editor;
  const rect = canvas.getBoundingClientRect();
  return {
    shape,
    box: new DOMRect(
      rect.left + (x - camera.x) * camera.zoom,
      rect.top + (y - camera.y) * camera.zoom,
      w * camera.zoom,
      h * camera.zoom,
    ),
    formats: wholeFormats(content),
    tagged: tagged(shape.id),
    run: (command) => textEditor.applyToWhole(shape, editor.camera, command),
  };
}

/** Hand the editor the carets of people in the same text, when they changed. */
function showEditorCarets(carets: RemoteCaret[]): void {
  const same =
    carets.length === editorCarets.length && carets.every((c, i) => c === editorCarets[i]);
  if (same) return;
  editorCarets = carets;
  textEditor.setCarets(carets);
}

/** On the canvas a click selects; a link under the pointer says how to open it. */
function showLinkTip(): void {
  const link = editor.hoverLink;
  const pointer = editor.pointer;
  linkTip.classList.toggle("shown", link !== null && pointer !== null);
  if (!link || !pointer) return;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  linkTip.replaceChildren(
    link,
    Object.assign(document.createElement("kbd"), { textContent: `${mod}-click to open` }),
  );
  const { camera } = editor;
  const rect = canvas.getBoundingClientRect();
  linkTip.style.left = `${rect.left + (pointer.x - camera.x) * camera.zoom + 14}px`;
  linkTip.style.top = `${rect.top + (pointer.y - camera.y) * camera.zoom + 18}px`;
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
    peerTextTimes: (count: number) => session.peerTextTrips.latest(count),
    sid: () => session.sid.toString(),
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
    rejoin: () => session.rebuild(),
    content: (id: string) => session.replica.view().texts.get(BigInt(id))?.content ?? null,
    carets: () => canvasCarets,
    editorCarets: () => textEditor.caretTexts(),
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
