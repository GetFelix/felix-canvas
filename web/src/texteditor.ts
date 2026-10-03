import {
  MAX_LIST_DEPTH,
  MAX_TEXT_LENGTH,
  bodyFragment,
  newBodyDoc,
  textClientId,
  type Doc,
  type Op,
} from "@felix-canvas/model";
import { baseKeymap } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { redo, undo, ySyncPlugin, ySyncPluginKey, yUndoPlugin } from "y-prosemirror";
import * as Y from "yjs";

import { TypingBuffer } from "./coalesce.js";
import type { Camera } from "./render.js";
import type { Session } from "./session.js";
import { RoundTrips } from "./session.js";
import type { Shape } from "./shapes.js";
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

  readonly #layer: HTMLElement;
  readonly #canvas: HTMLElement;
  readonly #session: Session;
  #host: HTMLElement | null = null;
  #view: EditorView | null = null;
  #doc: Y.Doc | null = null;
  #buffer: TypingBuffer | null = null;
  #fresh = false;
  #keyAt: number | null = null;

  constructor(layer: HTMLElement, canvas: HTMLElement, session: Session) {
    this.#layer = layer;
    this.#canvas = canvas;
    this.#session = session;
  }

  /** The open view, for commands and carets. */
  get view(): EditorView | null {
    return this.#view;
  }

  /** The open body's document. */
  get doc(): Y.Doc | null {
    return this.#doc;
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
        keymap(baseKeymap),
        this.#lengthBound(),
        placeholder,
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
    this.#view = view;
    this.#doc = doc;
    this.#buffer = buffer;
    this.#fresh = options.fresh ?? false;
    this.place(shape, camera);

    view.focus();
    const at = options.at && view.posAtCoords({ left: options.at.x, top: options.at.y });
    const selection = options.selectAll
      ? TextSelection.create(view.state.doc, 0, view.state.doc.content.size)
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
