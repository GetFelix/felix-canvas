import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { describe, expect, it } from "vitest";

import {
  formats,
  setColor,
  setLink,
  setSize,
  stepSize,
  toggleBold,
  toggleList,
} from "../src/textcommands.js";
import { wholeFormats } from "../src/textbar.js";
import { schema } from "../src/textschema.js";

const { nodes, marks } = schema;

/** A state with `texts` as paragraphs and the text from `from` to `to` selected. */
function state(texts: string[], from: number, to = from): EditorState {
  const doc = nodes.doc.create(
    null,
    texts.map((text) => nodes.p.create(null, text ? schema.text(text) : null)),
  );
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}

function run(start: EditorState, ...commands: Command[]): EditorState {
  return commands.reduce((current, command) => {
    let next = current;
    expect(command(current, (tr) => (next = current.apply(tr)))).toBe(true);
    return next;
  }, start);
}

describe("text commands", () => {
  it("switch a list between kinds and take it away", () => {
    const listed = run(state(["one", "two"], 1, 9), toggleList("ul"));
    expect(listed.doc.firstChild!.type).toBe(nodes.ul);
    expect(formats(listed).list).toBe("ul");
    const numbered = run(listed, toggleList("ol"));
    expect(numbered.doc.firstChild!.type).toBe(nodes.ol);
    expect(numbered.doc.firstChild!.childCount).toBe(2);
    const plain = run(numbered, toggleList("ol"));
    expect(plain.doc.firstChild!.type).toBe(nodes.p);
  });

  it("link to an address without a scheme as https, and refuse other schemes", () => {
    const linked = run(state(["felix"], 1, 6), setLink("felix.dev"));
    expect(formats(linked).link).toBe("https://felix.dev");
    expect(setLink("javascript:alert(1)")(linked)).toBe(false);
    // From a caret inside the link, the whole link goes.
    const caret = linked.apply(linked.tr.setSelection(TextSelection.create(linked.doc, 3)));
    expect(formats(caret).link).toBe("https://felix.dev");
    const unlinked = run(caret, setLink(null));
    expect(unlinked.doc.rangeHasMark(1, 6, marks.a)).toBe(false);
  });

  it("step the size up and down, with Medium as no mark", () => {
    let current = state(["size"], 1, 5);
    expect(formats(current).size).toBe("medium");
    current = run(current, stepSize(1), stepSize(1));
    expect(formats(current).size).toBe("huge");
    expect(stepSize(1)(current)).toBe(false);
    current = run(current, setSize("medium"));
    expect(current.doc.rangeHasMark(1, 5, marks.size)).toBe(false);
  });

  it("show a format as on only when all of the selection has it", () => {
    const half = run(state(["bold text"], 1, 5), toggleBold, setColor("coral"));
    expect(formats(half.apply(half.tr.setSelection(TextSelection.create(half.doc, 1, 10)))).b).toBe(
      false,
    );
    expect(formats(half).b).toBe(true);
    expect(formats(half).color).toBe("coral");
  });
});

describe("wholeFormats", () => {
  it("shows what every run of a body shares", () => {
    const body = [
      { heading: 2, lists: [], item: null, runs: [{ text: "a", marks: { b: true as const } }] },
      {
        heading: 2,
        lists: [],
        item: null,
        runs: [{ text: "b", marks: { b: true as const, i: true as const } }],
      },
    ];
    expect(wholeFormats(body)).toMatchObject({ block: 2, b: true, i: false, list: null });
  });
});
