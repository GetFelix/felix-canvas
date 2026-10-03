import { bodyFragment, locate, type TextBody, type TextPoint } from "@felix-canvas/model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";

/** How long a caret's name flag stays after its owner last typed or moved it. */
export const FLAG_MS = 2000;

/** Another person's selection in a body. */
export interface RemoteCaret {
  sid: bigint;
  shape: bigint;
  name: string;
  color: string;
  anchor: Uint8Array;
  head: Uint8Array;
  /** When it last moved, by `performance.now()`. */
  movedAt: number;
}

const key = new PluginKey<CaretState>("remote carets");

interface CaretState {
  carets: RemoteCaret[];
  /** Where each caret is in the editor's document, by session. */
  places: Map<bigint, { anchor: number; head: number }>;
}

/** Show `carets` in the editor of `view`'s state. */
export function setCarets(state: EditorState, carets: RemoteCaret[]) {
  return state.tr.setMeta(key, carets);
}

/**
 * Where other people's carets are in the editor's document. Positions resolve
 * against the editor's own document when the carets or the document change
 * from outside, and move with this editor's own typing in between: while
 * ProseMirror applies a keystroke, the Yjs document has not caught up yet. A
 * position that does not resolve, because the text it points into has not
 * arrived, keeps where it last was. The editor draws them over its text
 * rather than as decorations, since changing ProseMirror's DOM puts back a
 * selection it has not read yet, such as the one the Home key just made.
 */
export function caretsPlugin(doc: Y.Doc): Plugin {
  const resolve = (state: EditorState, carets: RemoteCaret[], old: CaretState["places"]) => {
    const places = new Map<bigint, { anchor: number; head: number }>();
    const binding = ySyncPluginKey.getState(state)?.binding;
    const size = state.doc.content.size;
    const at = (position: Uint8Array) => {
      try {
        const pos = relativePositionToAbsolutePosition(
          doc,
          bodyFragment(doc),
          Y.decodeRelativePosition(position),
          binding.mapping,
        );
        return pos === null ? null : Math.min(Math.max(pos, 0), size);
      } catch {
        return null;
      }
    };
    for (const caret of carets) {
      const head = binding ? at(caret.head) : null;
      const anchor = binding ? at(caret.anchor) : null;
      const place =
        head !== null && anchor !== null ? { anchor, head } : clampTo(old.get(caret.sid), size);
      if (place) places.set(caret.sid, place);
    }
    return places;
  };
  return new Plugin({
    key,
    state: {
      init: () => ({ carets: [], places: new Map() }),
      apply: (tr, value: CaretState, _old, state) => {
        const carets = (tr.getMeta(key) as RemoteCaret[] | undefined) ?? value.carets;
        const fromOutside = tr.getMeta(key) || tr.getMeta(ySyncPluginKey)?.isChangeOrigin;
        if (fromOutside) return { carets, places: resolve(state, carets, value.places) };
        if (!tr.docChanged) return value;
        const places = new Map(
          [...value.places].map(([sid, { anchor, head }]) => [
            sid,
            { anchor: tr.mapping.map(anchor), head: tr.mapping.map(head) },
          ]),
        );
        return { carets, places };
      },
    },
  });
}

/** Where `view`'s state places other people's carets. */
export function caretPlaces(
  state: EditorState,
): { caret: RemoteCaret; anchor: number; head: number }[] {
  const { carets, places } = key.getState(state)!;
  return carets.flatMap((caret) => {
    const place = places.get(caret.sid);
    return place ? [{ caret, ...place }] : [];
  });
}

function clampTo(
  shown: { anchor: number; head: number } | undefined,
  size: number,
): { anchor: number; head: number } | null {
  return shown ? { anchor: Math.min(shown.anchor, size), head: Math.min(shown.head, size) } : null;
}

/** A caret placed in a body's content, for the canvas to draw. */
export interface PlacedCaret {
  caret: RemoteCaret;
  anchor: TextPoint;
  head: TextPoint;
}

/**
 * Places carets in bodies the canvas draws, keeping each one's last place
 * while its positions point at text this tab does not have yet.
 */
export class CaretPlaces {
  readonly #last = new Map<
    bigint,
    { body: TextBody; caret: RemoteCaret; anchor: TextPoint; head: TextPoint }
  >();

  place(caret: RemoteCaret, body: TextBody): PlacedCaret | null {
    const last = this.#last.get(caret.sid);
    // Finding a position walks the body, so skip it while neither changed.
    if (last && last.body === body && last.caret === caret) return last;
    const head = locate(body, caret.head);
    const anchor = locate(body, caret.anchor);
    const placed = head && anchor ? { anchor, head } : last;
    if (!placed) return null;
    const next = { body, caret, anchor: placed.anchor, head: placed.head };
    this.#last.set(caret.sid, next);
    return next;
  }
}
