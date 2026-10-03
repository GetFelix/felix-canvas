import { isSafeLink, type FontSize, type TextColor } from "@felix-canvas/model";
import { setBlockType, toggleMark } from "prosemirror-commands";
import { inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Mark, MarkType } from "prosemirror-model";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { Selection, type Command, type EditorState, type Plugin } from "prosemirror-state";

import { schema } from "./textschema.js";

const { nodes, marks } = schema;

/** A paragraph, or a heading's level. */
export type BlockKind = "p" | 1 | 2 | 3;
export type ListKind = "ul" | "ol";

export const SIZES: FontSize[] = ["small", "medium", "large", "huge"];

export const toggleBold = toggleMark(marks.b);
export const toggleItalic = toggleMark(marks.i);
export const toggleUnderline = toggleMark(marks.u);

export function setBlock(kind: BlockKind): Command {
  return kind === "p" ? setBlockType(nodes.p) : setBlockType(nodes.h, { level: kind });
}

/**
 * Put the selection in a list of `kind`, take it out if it is in one
 * already, or switch the list it is in to the other kind.
 */
export function toggleList(kind: ListKind): Command {
  return (state, dispatch) => {
    const list = innermostList(state);
    if (!list) return wrapInList(nodes[kind])(state, dispatch);
    if (list.node.type === nodes[kind]) return liftListItem(nodes.li)(state, dispatch);
    dispatch?.(state.tr.setNodeMarkup(list.pos, nodes[kind]));
    return true;
  };
}

/** Set a size step on the selection, or the caret's next typing. Medium is no mark. */
export function setSize(step: FontSize): Command {
  return setValueMark(marks.size, step === "medium" ? null : { step });
}

/** Move the selection's size one step up or down from where its start is. */
export function stepSize(direction: 1 | -1): Command {
  return (state, dispatch) => {
    const index = SIZES.indexOf(formats(state).size) + direction;
    const step = SIZES[index];
    return step ? setSize(step)(state, dispatch) : false;
  };
}

/** Set a colour on the selection. Ink is no mark. */
export function setColor(name: TextColor): Command {
  return setValueMark(marks.color, name === "ink" ? null : { name });
}

/**
 * Link the selection to `href`, or the whole link the caret is in; `null`
 * removes the link. An address without a scheme is taken as `https:`.
 */
export function setLink(href: string | null): Command {
  return (state, dispatch) => {
    let address = href?.trim() ?? null;
    if (address && !/^[a-z][a-z0-9+.-]*:/i.test(address)) address = `https://${address}`;
    if (address && !isSafeLink(address)) return false;
    let { from, to } = state.selection;
    if (from === to) ({ from, to } = linkRange(state) ?? { from, to });
    if (from === to) return false;
    const tr = state.tr.removeMark(from, to, marks.a);
    if (address) tr.addMark(from, to, marks.a.create({ href: address }));
    dispatch?.(tr);
    return true;
  };
}

/** The address of the link at the caret, or on the selection's first text. */
export function linkAt(state: EditorState): string | null {
  const range = state.selection.empty ? linkRange(state) : null;
  const here = range ? state.doc.resolve(range.from + 1).marks() : marksHere(state);
  const mark = here.find((m) => m.type === marks.a);
  return (mark?.attrs.href as string | undefined) ?? null;
}

/** What the text bar shows as on: the formats where the selection starts or the caret is. */
export interface Formats {
  block: BlockKind;
  list: ListKind | null;
  b: boolean;
  i: boolean;
  u: boolean;
  link: string | null;
  size: FontSize;
  color: TextColor;
}

export function formats(state: EditorState): Formats {
  const { $from, empty, from, to } = state.selection;
  const active = (type: MarkType) =>
    empty
      ? Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
      : allHave(state, from, to, type);
  const here = marksHere(state);
  const value = (type: MarkType, attr: string) =>
    here.find((mark) => mark.type === type)?.attrs[attr] as string | undefined;
  const parent = $from.parent;
  return {
    block: parent.type === nodes.h ? (parent.attrs.level as 1 | 2 | 3) : "p",
    list: (innermostList(state)?.node.type.name as ListKind | undefined) ?? null,
    b: active(marks.b),
    i: active(marks.i),
    u: active(marks.u),
    link: linkAt(state),
    size: (value(marks.size, "step") as FontSize | undefined) ?? "medium",
    color: (value(marks.color, "name") as TextColor | undefined) ?? "ink",
  };
}

/** Keys for the formats, Markdown-style line starts, and Cmd+K for `onLink`. */
export function formatKeys(onLink: () => void): Plugin[] {
  return [
    keymap({
      "Mod-b": toggleBold,
      "Mod-i": toggleItalic,
      "Mod-u": toggleUnderline,
      "Mod-k": () => {
        onLink();
        return true;
      },
      "Mod-Alt-0": setBlock("p"),
      "Mod-Alt-1": setBlock(1),
      "Mod-Alt-2": setBlock(2),
      "Mod-Alt-3": setBlock(3),
      "Mod-Shift-8": toggleList("ul"),
      "Mod-Shift-7": toggleList("ol"),
      "Mod-Shift-.": stepSize(1),
      "Mod-Shift-,": stepSize(-1),
    }),
    inputRules({
      rules: [
        textblockTypeInputRule(/^(#{1,3})\s$/, nodes.h, (match) => ({ level: match[1]!.length })),
        wrappingInputRule(/^\s*[-*]\s$/, nodes.ul),
        wrappingInputRule(/^\d+\.\s$/, nodes.ol),
      ],
    }),
  ];
}

function setValueMark(type: MarkType, attrs: Record<string, string> | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) {
      const tr = state.tr.removeStoredMark(type);
      if (attrs) tr.addStoredMark(type.create(attrs));
      dispatch?.(tr);
      return true;
    }
    const tr = state.tr.removeMark(from, to, type);
    if (attrs) tr.addMark(from, to, type.create(attrs));
    dispatch?.(tr);
    return true;
  };
}

/** Whether every piece of text between `from` and `to` has the mark. */
function allHave(state: EditorState, from: number, to: number, type: MarkType): boolean {
  let all = true;
  let any = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    any = true;
    if (!type.isInSet(node.marks)) all = false;
    return false;
  });
  return any && all;
}

function innermostList(state: EditorState) {
  // A selection of everything starts outside any block; look where its text starts.
  const $from =
    state.selection.$from.depth > 0 ? state.selection.$from : Selection.atStart(state.doc).$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type === nodes.ul || node.type === nodes.ol) return { node, pos: $from.before(depth) };
  }
  return null;
}

/** The span of the link the selection starts in. */
function linkRange(state: EditorState): { from: number; to: number } | null {
  const { $from } = state.selection;
  const start = $from.start();
  const spans: { from: number; to: number; href: unknown }[] = [];
  $from.parent.forEach((child, offset) => {
    const href = child.marks.find((mark) => mark.type === marks.a)?.attrs.href;
    if (href === undefined) return;
    const from = start + offset;
    const last = spans.at(-1);
    if (last && last.href === href && last.to === from) last.to = from + child.nodeSize;
    else spans.push({ from, to: from + child.nodeSize, href });
  });
  return spans.find((span) => $from.pos >= span.from && $from.pos <= span.to) ?? null;
}

/** The marks of the first text in the selection, or those the caret would type with. */
function marksHere(state: EditorState): readonly Mark[] {
  const { $from, empty, from, to } = state.selection;
  if (empty) return state.storedMarks ?? $from.marks();
  let found: readonly Mark[] | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.isText) found = node.marks;
    return !node.isText;
  });
  return found ?? $from.marks();
}
