import * as Y from "yjs";

/** Font sizes in canvas units. A run with no size mark is Medium. */
export const FONT_SIZES = { small: 12, medium: 16, large: 20, huge: 28 } as const;
export type FontSize = keyof typeof FONT_SIZES;

/**
 * Text colours by name: Ink, Muted, then the presence palette in order. A run
 * with no colour mark is Ink. Cyan is not here on purpose: it means selected.
 */
export const TEXT_COLORS = [
  "ink",
  "muted",
  "coral",
  "orange",
  "amber",
  "green",
  "blue",
  "violet",
  "magenta",
  "rose",
] as const;
export type TextColor = (typeof TEXT_COLORS)[number];

/** Link addresses must use one of these. */
export const LINK_SCHEMES = ["http:", "https:", "mailto:"];
/** Lists nest at most this deep; deeper items show at this depth. */
export const MAX_LIST_DEPTH = 3;
/** A text op whose update is larger than this is ignored. */
export const MAX_TEXT_UPDATE = 64 * 1024;
/** The editor refuses to take a body past this many characters. */
export const MAX_TEXT_LENGTH = 10_000;
/** The shape types that can hold a body. */
export const TEXT_SHAPES: readonly string[] = ["text", "rect", "ellipse"];

/** A run's marks. Absent means off, Medium and Ink. */
export interface TextMarks {
  b?: true;
  i?: true;
  u?: true;
  /** The link address. */
  a?: string;
  size?: Exclude<FontSize, "medium">;
  color?: Exclude<TextColor, "ink">;
}

export interface TextRun {
  text: string;
  marks: TextMarks;
}

export type ListKind = "ul" | "ol";

/** A paragraph or heading, with the lists it sits in. */
export interface TextBlock {
  /** 0 for a paragraph, else the heading level, 1 to 3. */
  heading: number;
  /** The lists around the block, outermost first. */
  lists: ListKind[];
  /**
   * The block's number in its list, from 1, when it is the first block of a
   * list item and so carries the marker; `null` otherwise.
   */
  item: number | null;
  /** Runs of text, no two neighbours with the same marks. */
  runs: TextRun[];
}

/**
 * One shape's rich text: a Yjs document whose root `body` is an XML fragment
 * of the elements `p`, `h`, `ul`, `ol` and `li`, as `y-prosemirror` writes it.
 * Treat it as immutable. Its encoded state and its derived content are worked
 * out on first use.
 */
export class TextBody {
  #state: Uint8Array | null;
  #doc: Y.Doc | null;
  #content: TextBlock[] | null = null;

  private constructor(state: Uint8Array | null, doc: Y.Doc | null) {
    this.#state = state;
    this.#doc = doc;
  }

  /** A body from `Y.encodeStateAsUpdateV2` of its document. */
  static fromState(state: Uint8Array): TextBody {
    return new TextBody(state, null);
  }

  /** A body holding `doc`, which nothing else may change from now on. */
  static fromDoc(doc: Y.Doc): TextBody {
    return new TextBody(null, doc);
  }

  /** The document's state, as `Y.encodeStateAsUpdateV2` gives it. */
  get state(): Uint8Array {
    return (this.#state ??= Y.encodeStateAsUpdateV2(this.#doc!));
  }

  /** What the body shows: only what the schema allows. */
  get content(): TextBlock[] {
    return (this.#content ??= walk(this.doc()));
  }

  /** The body as a document, for reading only. */
  doc(): Y.Doc {
    return (this.#doc ??= decodeBody(this.state));
  }

  /** A document holding this body that the caller may change. This body stays as it is. */
  editable(): Y.Doc {
    const state = this.state;
    const doc = this.#doc;
    this.#doc = null;
    return doc ?? decodeBody(state);
  }
}

/** An empty body document. */
export function newBodyDoc(): Y.Doc {
  return new Y.Doc({ gc: true });
}

/** The body's root, the fragment the editor binds to. */
export function bodyFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment("body");
}

function decodeBody(state: Uint8Array): Y.Doc {
  const doc = newBodyDoc();
  try {
    Y.applyUpdateV2(doc, state);
  } catch {
    // A state that does not decode reads as an empty body on every replica.
  }
  return doc;
}

/**
 * The Yjs client id for a session: 32 bits of its id, so a body gains one
 * entry in its state vector per session that edits it.
 */
export function textClientId(sid: bigint): number {
  return Number(BigInt.asUintN(32, sid ^ (sid >> 32n)));
}

// History folds the same ops again on every seek, so each is checked once.
const checked = new WeakMap<Uint8Array, boolean>();

/** Whether `update` is a Yjs version 2 update the fold may apply. */
export function isTextUpdate(update: unknown): update is Uint8Array {
  if (!(update instanceof Uint8Array) || update.length > MAX_TEXT_UPDATE) return false;
  let valid = checked.get(update);
  if (valid === undefined) {
    try {
      // Reads every struct and the delete set, so a malformed update is
      // refused before it can change half a document.
      Y.decodeUpdateV2(update);
      valid = true;
    } catch {
      valid = false;
    }
    checked.set(update, valid);
  }
  return valid;
}

/** Apply a checked update to a body document. */
export function applyTextUpdate(doc: Y.Doc, update: Uint8Array): void {
  Y.applyUpdateV2(doc, update);
}

/** Merge updates into one, as one op carries them. */
export function mergeTextUpdates(updates: Uint8Array[]): Uint8Array {
  return updates.length === 1 ? updates[0]! : Y.mergeUpdatesV2(updates);
}

/**
 * What the document is waiting for, as a string that stays the same while it
 * waits for the same thing, or `null` when it holds no update waiting for
 * others. In a fold that read every record in order, waiting means a record
 * was skipped, or the log never held what an author's update depends on.
 */
export function pendingText(doc: Y.Doc): string | null {
  const { pendingStructs, pendingDs } = doc.store;
  if (!pendingStructs && !pendingDs) return null;
  const missing = pendingStructs ? [...pendingStructs.missing].sort(([a], [b]) => a - b) : [];
  return JSON.stringify([missing, pendingDs !== null]);
}

/** Whether a body shows nothing: no blocks, or one empty paragraph. */
export function isBlank(content: TextBlock[]): boolean {
  if (content.length === 0) return true;
  const [only] = content;
  return (
    content.length === 1 &&
    only!.heading === 0 &&
    only!.lists.length === 0 &&
    only!.runs.length === 0
  );
}

/** The plain text of a body, blocks joined by newlines. */
export function plainText(content: TextBlock[]): string {
  return content.map((block) => block.runs.map((run) => run.text).join("")).join("\n");
}

/** Where a text position falls in a body's content: a block and a character offset in it. */
export interface TextPoint {
  block: number;
  offset: number;
}

/**
 * Resolve an encoded Yjs relative position against `body`. Returns `null`
 * when it points at text the body does not hold yet.
 */
export function locate(body: TextBody, position: Uint8Array): TextPoint | null {
  let absolute: Y.AbsolutePosition | null;
  const doc = body.doc();
  try {
    absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(position),
      doc,
    );
  } catch {
    return null;
  }
  if (!absolute) return null;
  const { type, index } = absolute;
  if (type === bodyFragment(doc)) return { block: 0, offset: 0 };
  let found: TextPoint | null = null as TextPoint | null;
  walk(doc, (block, node, offset) => {
    if (node === type) found = { block, offset: node instanceof Y.XmlText ? offset + index : 0 };
  });
  return found;
}

/**
 * Walk a body document into blocks, leaving out anything the schema does not
 * have. `visit` sees each paragraph and heading element, at offset 0, and
 * each text node with the offset in its block where it starts.
 */
function walk(
  doc: Y.Doc,
  visit?: (block: number, node: Y.XmlElement | Y.XmlText, offset: number) => void,
): TextBlock[] {
  const blocks: TextBlock[] = [];
  const container = (
    node: Y.XmlFragment | Y.XmlElement,
    lists: ListKind[],
    item: number | null,
  ) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const name = child.nodeName;
      if (name === "p" || name === "h") {
        const block: TextBlock = {
          heading: name === "h" ? level(child) : 0,
          lists,
          item,
          runs: [],
        };
        item = null;
        visit?.(blocks.length, child, 0);
        let offset = 0;
        for (const text of child.toArray()) {
          if (!(text instanceof Y.XmlText)) continue;
          visit?.(blocks.length, text, offset);
          for (const { insert, attributes } of text.toDelta() as Delta[]) {
            if (typeof insert !== "string") continue;
            offset += insert.length;
            addRun(block.runs, insert, marksOf(attributes ?? {}));
          }
        }
        blocks.push(block);
      } else if (name === "ul" || name === "ol") {
        const nested: ListKind[] = lists.length < MAX_LIST_DEPTH ? [...lists, name] : lists;
        let number = 0;
        for (const entry of child.toArray()) {
          if (entry instanceof Y.XmlElement && entry.nodeName === "li") {
            container(entry, nested, ++number);
          }
        }
      }
    }
  };
  container(bodyFragment(doc), [], null);
  return blocks;
}

interface Delta {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

function level(element: Y.XmlElement): number {
  const value = Number(element.getAttribute("level"));
  return value === 2 || value === 3 ? value : 1;
}

function addRun(runs: TextRun[], text: string, marks: TextMarks): void {
  const last = runs.at(-1);
  if (last && sameMarks(last.marks, marks)) last.text += text;
  else runs.push({ text, marks });
}

const MARK_KEYS = ["b", "i", "u", "a", "size", "color"] as const;

export function sameMarks(a: TextMarks, b: TextMarks): boolean {
  return MARK_KEYS.every((key) => a[key] === b[key]);
}

/** The marks `y-prosemirror` stored as text attributes, keeping only the schema's. */
function marksOf(attributes: Record<string, unknown>): TextMarks {
  const marks: TextMarks = {};
  const attr = (name: string) => {
    const value = attributes[name];
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  };
  if (attr("b")) marks.b = true;
  if (attr("i")) marks.i = true;
  if (attr("u")) marks.u = true;
  const href = attr("a")?.href;
  if (typeof href === "string" && isSafeLink(href)) marks.a = href;
  const step = attr("size")?.step;
  if (step === "small" || step === "large" || step === "huge") marks.size = step;
  const color = attr("color")?.name;
  if (TEXT_COLORS.includes(color as TextColor) && color !== "ink") {
    marks.color = color as Exclude<TextColor, "ink">;
  }
  return marks;
}

/** Whether a link address uses a scheme the canvas will open. */
export function isSafeLink(href: string): boolean {
  try {
    return LINK_SCHEMES.includes(new URL(href).protocol);
  } catch {
    return false;
  }
}
