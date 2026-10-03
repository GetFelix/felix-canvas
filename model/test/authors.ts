import * as Y from "yjs";

import { bodyFragment, mergeTextUpdates, textClientId, type Op } from "../src/index.js";

/**
 * A session typing into bodies as the editor does: a document per body with
 * the session's client id, which sees the log's text ops for that body and
 * turns its own changes into text ops.
 */
export class Author {
  readonly sid: bigint;
  seq = 0;
  readonly #docs = new Map<bigint, Y.Doc>();
  /** How much of the log the author has read. */
  #read = 0;
  #out: Uint8Array[] = [];

  constructor(sid: bigint) {
    this.sid = sid;
  }

  /** The author's document for `shape`. */
  doc(shape: bigint): Y.Doc {
    let doc = this.#docs.get(shape);
    if (!doc) {
      doc = new Y.Doc();
      doc.clientID = textClientId(this.sid);
      doc.on("updateV2", (update: Uint8Array, origin: unknown) => {
        if (origin !== "log") this.#out.push(update);
      });
      this.#docs.set(shape, doc);
    }
    return doc;
  }

  /** Take in every text op in `log` this author has not seen, in order. */
  catchUp(log: readonly (Op | null)[]): void {
    for (; this.#read < log.length; this.#read++) {
      const op = log[this.#read];
      if (op?.kind === "text")
        Y.applyUpdateV2(this.doc(op.shape), op.fields.y as Uint8Array, "log");
    }
  }

  /** Change the body of `shape` and return the text op that carries the change. */
  edit(shape: bigint, change: (body: Y.XmlFragment) => void): Op {
    const doc = this.doc(shape);
    doc.transact(() => change(bodyFragment(doc)));
    const y = mergeTextUpdates(this.#out.splice(0));
    return { sid: this.sid, seq: this.seq++, shape, kind: "text", fields: { y } };
  }
}

/** A paragraph, or another element, holding one run of text. */
export function block(
  text: string,
  attributes: Record<string, unknown> = {},
  name = "p",
): Y.XmlElement {
  const element = new Y.XmlElement(name);
  const run = new Y.XmlText();
  run.insert(0, text, attributes);
  element.insert(0, [run]);
  return element;
}

/** The first text node of the body's first block. */
export function firstText(body: Y.XmlFragment): Y.XmlText {
  return (body.get(0) as Y.XmlElement).get(0) as Y.XmlText;
}
