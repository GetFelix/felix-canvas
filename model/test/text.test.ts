import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import {
  EMPTY_DOC,
  MAX_TEXT_UPDATE,
  apply,
  applyInPlace,
  draft,
  freeze,
  locate,
  plainText,
  stateHash,
  textClientId,
  type Doc,
  type Op,
} from "../src/index.js";
import { Author, block, firstText } from "./authors.js";

const box = 0x1234n;

const create = (author: Author, shape = box, type = "text"): Op => ({
  sid: author.sid,
  seq: author.seq++,
  shape,
  kind: "create",
  fields: { type, x: 0, y: 0, w: 200, h: 0, z: "V" },
});

/** Fold `log` with {@link apply} and, separately, in place, checking they agree after every op. */
function foldBoth(log: readonly (Op | null)[], base: Doc = EMPTY_DOC): Doc {
  let doc = base;
  const working = draft(base);
  for (const [offset, op] of log.entries()) {
    if (!op) continue;
    doc = apply(doc, op, offset);
    applyInPlace(working, op, offset);
    expect(stateHash(freeze(working))).toBe(stateHash(doc));
  }
  return doc;
}

const text = (doc: Doc, shape = box) => plainText(doc.texts.get(shape)?.content ?? []);

describe("text ops", () => {
  it("merge two people typing into one paragraph at once", () => {
    const a = new Author(1n);
    const b = new Author(2n);
    const log: Op[] = [create(a)];
    log.push(a.edit(box, (body) => body.insert(0, [block("The cat sat")])));
    a.catchUp(log);
    b.catchUp(log);
    // Both type at the same place before either sees the other's change.
    const fromA = a.edit(box, (body) => firstText(body).insert(4, "black "));
    const fromB = b.edit(box, (body) => firstText(body).insert(4, "fat "));
    log.push(fromA, fromB);

    const doc = foldBoth(log);
    expect(text(doc)).toMatch(/^The (black fat|fat black) cat sat$/);
    // The other order in the log gives another valid merge, but every replica of one log agrees.
    const other = foldBoth([log[0]!, log[1]!, fromB, fromA]);
    expect(text(other)).toMatch(/^The (black fat|fat black) cat sat$/);
  });

  it("keep formatting and typing that race on the same words", () => {
    const a = new Author(1n);
    const b = new Author(2n);
    const log: Op[] = [create(a, box, "rect")];
    log.push(a.edit(box, (body) => body.insert(0, [block("hello world")])));
    a.catchUp(log);
    b.catchUp(log);
    log.push(a.edit(box, (body) => firstText(body).format(0, 5, { b: {} })));
    log.push(b.edit(box, (body) => firstText(body).insert(2, "XY")));
    const doc = foldBoth(log);
    const [only] = doc.texts.get(box)!.content;
    expect(only!.runs.map((run) => [run.text, run.marks])).toEqual([
      ["heXYllo", { b: true }],
      [" world", {}],
    ]);
  });

  it("ignore repeats of an op, wherever in the log they land", () => {
    const a = new Author(1n);
    const log: (Op | null)[] = [create(a)];
    const typed = a.edit(box, (body) => body.insert(0, [block("once")]));
    log.push(typed, null, typed);
    a.catchUp(log);
    log.push(
      a.edit(box, (body) => firstText(body).insert(4, " more")),
      typed,
    );
    expect(text(foldBoth(log))).toBe("once more");
  });

  it("leave out what the schema does not have", () => {
    const a = new Author(1n);
    const log: Op[] = [create(a)];
    log.push(
      a.edit(box, (body) =>
        body.insert(0, [
          block("kept", { b: {}, strike: {}, color: { name: "cyan" } }),
          block("table", {}, "table"),
          block("x", { a: { href: "javascript:alert(1)" }, size: { step: "massive" } }),
          block("y", { a: { href: "https://felix.dev" }, color: { name: "coral" } }),
        ]),
      ),
    );
    const content = foldBoth(log).texts.get(box)!.content;
    expect(content.map((b) => b.runs)).toEqual([
      [{ text: "kept", marks: { b: true } }],
      [{ text: "x", marks: {} }],
      [{ text: "y", marks: { a: "https://felix.dev", color: "coral" } }],
    ]);
  });

  it("lay out headings and nested lists as blocks", () => {
    const a = new Author(1n);
    const log: Op[] = [create(a)];
    log.push(
      a.edit(box, (body) => {
        const heading = block("Title", {}, "h");
        heading.setAttribute("level", 2 as unknown as string);
        const inner = new Y.XmlElement("ul");
        inner.insert(0, [item("deep")]);
        const second = item("two");
        second.insert(1, [inner]);
        const list = new Y.XmlElement("ol");
        list.insert(0, [item("one"), second]);
        body.insert(0, [heading, list]);
      }),
    );
    const content = foldBoth(log).texts.get(box)!.content;
    expect(content.map(({ heading, lists, item }) => ({ heading, lists, item }))).toEqual([
      { heading: 2, lists: [], item: null },
      { heading: 0, lists: ["ol"], item: 1 },
      { heading: 0, lists: ["ol"], item: 2 },
      { heading: 0, lists: ["ol", "ul"], item: 1 },
    ]);
  });

  it("are ignored on missing shapes, lines and strokes, or when malformed or too large", () => {
    const a = new Author(1n);
    const line = 0x99n;
    const update = (shape: bigint) => a.edit(shape, (body) => body.insert(0, [block("hi")]));
    const log: Op[] = [create(a, line, "line"), create(a)];
    log.push(update(line), update(0x404n));
    log.push({ ...update(box), fields: { y: new Uint8Array([1, 2, 3]) } });
    log.push({ ...update(box), fields: { y: "not bytes" } });
    log.push(a.edit(box, (body) => body.insert(0, [block("x".repeat(MAX_TEXT_UPDATE))])));
    const doc = foldBoth(log);
    expect(doc.texts.size).toBe(0);
    expect(doc.seqs.get(a.sid)).toBe(a.seq - 1);
  });

  it("lose their body when the shape is deleted, for good", () => {
    const a = new Author(1n);
    const log: Op[] = [create(a)];
    log.push(a.edit(box, (body) => body.insert(0, [block("gone")])));
    log.push({ sid: a.sid, seq: a.seq++, shape: box, kind: "delete", fields: {} });
    a.catchUp(log);
    log.push(a.edit(box, (body) => firstText(body).insert(0, "still ")));
    expect(foldBoth(log).texts.size).toBe(0);
  });
});

describe("stateHash", () => {
  it("is the same for bodies that read the same but were typed differently", () => {
    const one = new Author(1n);
    const first: Op[] = [create(one)];
    first.push(one.edit(box, (body) => body.insert(0, [block("hello")])));
    one.catchUp(first);
    first.push(one.edit(box, (body) => firstText(body).format(0, 5, { b: {} })));

    const two = new Author(2n);
    const three = new Author(3n);
    const second: Op[] = [create(two)];
    second.push(two.edit(box, (body) => body.insert(0, [block("hexlo", { b: {} })])));
    three.catchUp(second);
    second.push(three.edit(box, (body) => firstText(body).delete(2, 1)));
    three.catchUp(second);
    second.push(three.edit(box, (body) => firstText(body).insert(2, "l", { b: {} })));

    const a = foldBoth(first);
    const b = foldBoth(second);
    expect(a.texts.get(box)!.state).not.toEqual(b.texts.get(box)!.state);
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it("counts an emptied body as no body", () => {
    const a = new Author(1n);
    const log: Op[] = [create(a)];
    const before = stateHash(foldBoth(log));
    log.push(a.edit(box, (body) => body.insert(0, [block("typo")])));
    a.catchUp(log);
    expect(stateHash(foldBoth(log))).not.toBe(before);
    log.push(a.edit(box, (body) => firstText(body).delete(0, 4)));
    expect(stateHash(foldBoth(log))).toBe(before);
  });
});

describe("locate", () => {
  it("follows a character while text is inserted before it", () => {
    const a = new Author(1n);
    const b = new Author(2n);
    const log: Op[] = [create(a)];
    log.push(a.edit(box, (body) => body.insert(0, [block("first"), block("second line")])));
    b.catchUp(log);
    const second = (b.doc(box).getXmlFragment("body").get(1) as Y.XmlElement).get(0) as Y.XmlText;
    const caret = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(second, 7));
    a.catchUp(log);
    log.push(
      a.edit(box, (body) => ((body.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "my ")),
    );
    expect(locate(foldBoth(log).texts.get(box)!, caret)).toEqual({ block: 1, offset: 10 });
  });
});

describe("textClientId", () => {
  it("is a u32 that differs between sessions", () => {
    const ids = [1n, 2n, 0xffff_ffff_ffff_ffffn, 1n << 40n].map(textClientId);
    for (const id of ids) expect(id >>> 0).toBe(id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function item(text: string): Y.XmlElement {
  const li = new Y.XmlElement("li");
  li.insert(0, [block(text)]);
  return li;
}
