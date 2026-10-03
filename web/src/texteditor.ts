import {
  MAX_LIST_DEPTH,
  MAX_TEXT_LENGTH,
  bodyFragment,
  newBodyDoc,
  textClientId,
  type Doc,
  type Op,
  type TextSelection as SharedSelection,
} from "@felix-canvas/model";
import { baseKeymap } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { EditorState, Plugin, Selection, TextSelection, type Command } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import {
  absolutePositionToRelativePosition,
  redo,
  undo,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
} from "y-prosemirror";
import * as Y from "yjs";

import { TypingBuffer } from "./coalesce.js";
import type { Camera } from "./render.js";
import type { Session } from "./session.js";
import { RoundTrips } from "./session.js";
import type { Shape } from "./shapes.js";
import { FLAG_MS, caretPlaces, caretsPlugin, setCarets, type RemoteCaret } from "./textcarets.js";
import { formatKeys, formats, type Formats } from "./textcommands.js";
import { BOX_PADDING } from "./textlayout.js";
import { schema } from "./textschema.js";

/** Marks updates this tab applied from the log, as opposed to its own typing. */
const FROM_LOG = Symbol("from the log");

export interface OpenOptions {
  /** A text box made a moment ago: if it is left empty, it goes. */
  fresh?: boolean;
  /** Where to put the caret, in client coordinates; the end of the text otherwise. */
  at?: { x: number; y: number };
  selectAll?: boolean;
  /** Edit without showing or focusing anything, to format the whole body at once. */
  hidden?: boolean;
}

/**
 * The editor over the canvas: a ProseMirror view of one shape's body,
 * positioned and scaled over the shape, while the canvas leaves that body
 * out. It works on a Yjs document of its own, the body as the replica shows
 * it, plus every text op the log delivers while it is open. Yjs merges are
 * idempotent, so this tab's own ops coming back change nothing. Local changes
 * are coalesced into text ops by a {@link TypingBuffer}.
 */
export class TextEditor {
  /** The shape being edited, or `null`. */
  shape: bigint | null = null;
  /** Keystroke to the frame that shows it, in milliseconds. */
  readonly echoTrips = new RoundTrips();
  /** Called when editing stops, with the shape and whether it was a new box left empty. */
  onClose: (shape: bigint, abandoned: boolean) => void = () => {};
  /** Called when a change would take the body past its length bound. */
  onTooLong: () => void = () => {};
  /** Called whenever the editor's selection or content changed. */
  onSelectionChange: () => void = () => {};
  /** Called for Cmd+K. */
  onLink: () => void = () => {};
  /** Called when the pointer moves onto a link in the text, or off one with `null`. */
  onLinkHover: (link: { href: string; box: DOMRect } | null) => void = () => {};

  readonly #layer: HTMLElement;
  readonly #canvas: HTMLElement;
  readonly #session: Session;
  #host: HTMLElement | null = null;
  #view: EditorView | null = null;
  #doc: Y.Doc | null = null;
  #buffer: TypingBuffer | null = null;
  #carets: HTMLElement | null = null;
  /** The pointer over the editor, in client coordinates, to show a hovered caret's name. */
  #pointer: { x: number; y: number } | null = null;
  #fresh = false;
  #hidden = false;
  #keyAt: number | null = null;

  constructor(layer: HTMLElement, canvas: HTMLElement, session: Session) {
    this.#layer = layer;
    this.#canvas = canvas;
    this.#session = session;
  }

  /** The formats at the caret or the selection's start, while editing. */
  formats(): Formats | null {
    return this.#view && !this.#hidden ? formats(this.#view.state) : null;
  }

  /** The editor's box on screen, while editing. */
  box(): DOMRect | null {
    return this.#host && !this.#hidden ? this.#host.getBoundingClientRect() : null;
  }

  /** Run a command on the text being edited. */
  run(command: Command): boolean {
    const view = this.#view;
    if (!view) return false;
    const done = command(view.state, view.dispatch);
    if (!this.#hidden) view.focus();
    return done;
  }

  /** Put the caret back in the text, as after using the text bar. */
  focus(): void {
    if (!this.#hidden) this.#view?.focus();
  }

  /** Run a command on all of `shape`'s text without opening it on screen. */
  applyToWhole(shape: Shape, camera: Camera, command: Command): void {
    this.open(shape, camera, { hidden: true, selectAll: true });
    this.run(command);
    this.close();
  }

  /** The selection to share with others, while editing. */
  selection(): SharedSelection | undefined {
    const view = this.#view;
    const binding = view && ySyncPluginKey.getState(view.state)?.binding;
    if (!view || !binding || this.#hidden || this.shape === null) return undefined;
    const type = bodyFragment(this.#doc!);
    const relative = (pos: number) =>
      Y.encodeRelativePosition(absolutePositionToRelativePosition(pos, type, binding.mapping));
    const { anchor, head } = view.state.selection;
    return { shape: this.shape, anchor: relative(anchor), head: relative(head) };
  }

  /** Show other people's carets in the open body. */
  setCarets(carets: RemoteCaret[]): void {
    const view = this.#view;
    if (view) view.dispatch(setCarets(view.state, carets));
  }

  /** The text before each other person's caret in its block, for the end-to-end tests. */
  caretTexts(): { name: string; before: string }[] {
    const state = this.#view?.state;
    if (!state) return [];
    return caretPlaces(state).map(({ caret, head }) => {
      const $head = state.doc.resolve(head);
      return { name: caret.name, before: state.doc.textBetween($head.start(), head) };
    });
  }

  /**
   * Draw other people's carets and selections over the text, in the editor's
   * own units: a 2 px bar a line tall, and a flag with their name while they
   * type and for a moment after, which then shrinks to a small cap.
   */
  drawCarets(now = performance.now()): void {
    const view = this.#view;
    const host = this.#host;
    const layer = this.#carets;
    if (!view || !host || !layer || this.#hidden) return;
    const box = host.getBoundingClientRect();
    const zoom = Number(host.style.getPropertyValue("--zoom")) || 1;
    const place = (
      element: HTMLElement,
      left: number,
      top: number,
      width: number,
      height: number,
    ) => {
      element.style.transform = `translate(${(left - box.left) / zoom}px, ${(top - box.top) / zoom}px)`;
      element.style.width = `${width / zoom}px`;
      element.style.height = `${height / zoom}px`;
      return element;
    };
    const nodes: HTMLElement[] = [];
    for (const { caret, anchor, head } of caretPlaces(view.state)) {
      if (anchor !== head) {
        const from = view.domAtPos(Math.min(anchor, head));
        const to = view.domAtPos(Math.max(anchor, head));
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        for (const rect of range.getClientRects()) {
          const shade = place(
            span("remote-selection"),
            rect.left,
            rect.top,
            rect.width,
            rect.height,
          );
          shade.style.setProperty("--peer", caret.color);
          nodes.push(shade);
        }
      }
      const at = view.coordsAtPos(head);
      const bar = place(span("remote-caret"), at.left - zoom, at.top, 2 * zoom, at.bottom - at.top);
      bar.style.setProperty("--peer", caret.color);
      const pointer = this.#pointer;
      const hovered =
        pointer !== null &&
        Math.abs(pointer.x - at.left) < 6 &&
        pointer.y >= at.top &&
        pointer.y <= at.bottom;
      const shrink = hovered ? 0 : Math.min(1, Math.max(0, (now - caret.movedAt - FLAG_MS) / 140));
      const flag = span("remote-flag", caret.name);
      flag.style.opacity = String(1 - shrink);
      const cap = span("remote-cap");
      cap.style.opacity = String(shrink);
      bar.append(flag, cap);
      nodes.push(bar);
    }
    layer.replaceChildren(...nodes);
  }

  open(shape: Shape, camera: Camera, options: OpenOptions = {}): void {
    if (this.shape === shape.id) return;
    this.close();
    const sid = this.#session.sid;
    const doc = newBodyDoc();
    doc.clientID = textClientId(sid);
    const body = this.#session.replica.view().texts.get(shape.id);
    if (body) Y.applyUpdateV2(doc, body.state, FROM_LOG);
    const id = shape.id;
    const buffer = new TypingBuffer((y, firstAt) =>
      this.#session.submit("text", id, { y }, firstAt),
    );
    doc.on("updateV2", (update: Uint8Array, origin: unknown) => {
      if (origin !== FROM_LOG) buffer.add(update);
    });

    const host = document.createElement("div");
    host.className = `text-editor ${shape.type === "text" ? "text-shape" : "text-box"}`;
    // The sync plugin draws the body into the view when it starts. It also
    // drops anything outside the schema, which only a broken client writes.
    const state = EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(bodyFragment(doc)),
        yUndoPlugin({ protectedNodes: new Set(["p"]) }),
        keymap({
          // All the text, rather than ProseMirror's selection of the whole
          // document, which list and link commands cannot work on.
          "Mod-a": (state, dispatch) => {
            dispatch?.(state.tr.setSelection(allText(state)));
            return true;
          },
          "Mod-z": undo,
          "Mod-y": redo,
          "Mod-Shift-z": redo,
          Escape: () => {
            // After ProseMirror has finished with the key event.
            queueMicrotask(() => this.close());
            return true;
          },
          Enter: splitListItem(schema.nodes.li),
          // Tab never leaves the text, even where it cannot indent.
          Tab: (state, dispatch) =>
            (listDepth(state) < MAX_LIST_DEPTH && sink(state, dispatch)) || true,
          "Shift-Tab": (state, dispatch) => liftListItem(schema.nodes.li)(state, dispatch) || true,
        }),
        ...formatKeys(() => this.onLink()),
        keymap(baseKeymap),
        this.#lengthBound(),
        placeholder,
        caretsPlugin(doc),
      ],
    });
    const editor = this;
    const view = new EditorView(host, {
      state,
      attributes: { class: "text-body", spellcheck: "true" },
      // The sync plugin dispatches while the view is still being made, so
      // this cannot refer to `view`.
      dispatchTransaction(this: EditorView, tr) {
        this.updateState(this.state.apply(tr));
        editor.#dispatched();
      },
    });
    host.addEventListener("keydown", (event) => (this.#keyAt = event.timeStamp), true);
    const carets = document.createElement("div");
    carets.className = "remote-carets";
    host.append(carets);
    host.addEventListener("pointerleave", () => {
      this.#pointer = null;
      this.drawCarets();
    });
    let hovered: Element | null = null;
    host.addEventListener("pointermove", (event) => {
      this.#pointer = { x: event.clientX, y: event.clientY };
      this.drawCarets();
      const link = (event.target as Element).closest("a[href]");
      if (link === hovered) return;
      hovered = link;
      this.onLinkHover(
        link ? { href: link.getAttribute("href")!, box: link.getBoundingClientRect() } : null,
      );
    });
    // Panning and zooming still work over the text.
    host.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.#canvas.dispatchEvent(new WheelEvent("wheel", event));
      },
      { passive: false },
    );
    this.#layer.append(host);
    this.shape = id;
    this.#host = host;
    this.#carets = carets;
    this.#view = view;
    this.#doc = doc;
    this.#buffer = buffer;
    this.#fresh = options.fresh ?? false;
    this.#hidden = options.hidden ?? false;
    if (this.#hidden) host.style.visibility = "hidden";
    this.place(shape, camera);

    if (!this.#hidden) view.focus();
    const at = options.at && view.posAtCoords({ left: options.at.x, top: options.at.y });
    const selection = options.selectAll
      ? allText(view.state)
      : at
        ? TextSelection.create(view.state.doc, at.pos)
        : TextSelection.atEnd(view.state.doc);
    view.dispatch(view.state.tr.setSelection(selection));
  }

  /** Stop editing. Unsent typing goes out at once. */
  close(): void {
    const id = this.shape;
    if (id === null) return;
    this.#buffer!.flush();
    const view = this.#view!;
    const empty = view.state.doc.childCount === 1 && view.state.doc.textContent.length === 0;
    const firstIsParagraph = view.state.doc.firstChild?.type === schema.nodes.p;
    view.destroy();
    this.#doc!.destroy();
    this.#host!.remove();
    this.shape = null;
    this.#view = null;
    this.#doc = null;
    this.#buffer = null;
    this.#host = null;
    this.#carets = null;
    this.#pointer = null;
    this.onLinkHover(null);
    this.onClose(id, this.#fresh && empty && firstIsParagraph);
  }

  /** Take an op as it enters the fold: text for the open body joins the editor's document. */
  receive(op: Op): void {
    if (op.kind === "text" && op.shape === this.shape && op.fields.y instanceof Uint8Array) {
      try {
        Y.applyUpdateV2(this.#doc!, op.fields.y, FROM_LOG);
      } catch {
        // The fold refuses it too.
      }
    }
  }

  /** Merge the body from a snapshot the session rejoined from. The caret and unsent text stay. */
  rebase(doc: Doc): void {
    const body = this.shape === null ? undefined : doc.texts.get(this.shape);
    if (body) Y.applyUpdateV2(this.#doc!, body.state, FROM_LOG);
  }

  /** Put the editor over `shape` as the camera shows it. */
  place(shape: Shape, camera: Camera): void {
    const host = this.#host;
    if (!host) return;
    const box = shape.type !== "text";
    const left = box ? shape.x + BOX_PADDING : shape.x;
    host.style.transform =
      `translate(${(left - camera.x) * camera.zoom}px, ${(shape.y - camera.y) * camera.zoom}px) ` +
      `scale(${camera.zoom})`;
    host.style.width = box
      ? `${Math.max(1, shape.w - BOX_PADDING * 2)}px`
      : shape.grows
        ? "max-content"
        : `${shape.w}px`;
    host.style.height = box ? `${shape.h}px` : "";
    host.style.setProperty("--zoom", String(camera.zoom));
  }

  #dispatched(): void {
    if (this.#keyAt !== null) {
      const keyAt = this.#keyAt;
      this.#keyAt = null;
      requestAnimationFrame(() => this.echoTrips.add(performance.now() - keyAt));
    }
    this.onSelectionChange();
  }

  #lengthBound(): Plugin {
    return new Plugin({
      filterTransaction: (tr, state) => {
        if (!tr.docChanged || tr.getMeta(ySyncPluginKey)) return true;
        const length = tr.doc.textContent.length;
        if (length <= MAX_TEXT_LENGTH || length <= state.doc.textContent.length) return true;
        this.onTooLong();
        return false;
      },
    });
  }
}

const sink = sinkListItem(schema.nodes.li);

/** How many lists the selection's start sits in. */
function listDepth(state: EditorState): number {
  const { $from } = state.selection;
  let depth = 0;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.li) depth++;
  }
  return depth;
}

/** "Type something" in a body with nothing in it. */
const placeholder = new Plugin({
  props: {
    decorations: ({ doc }) => {
      const only = doc.firstChild;
      if (doc.childCount !== 1 || only?.type !== schema.nodes.p || only.content.size > 0) {
        return null;
      }
      return DecorationSet.create(doc, [
        Decoration.node(0, only.nodeSize, { class: "placeholder" }),
      ]);
    },
  },
});

function span(className: string, text = ""): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

function allText(state: EditorState): Selection {
  return TextSelection.between(Selection.atStart(state.doc).$from, Selection.atEnd(state.doc).$to);
}
