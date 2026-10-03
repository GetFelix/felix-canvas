import {
  EMPTY_DOC,
  apply,
  applyInPlace,
  decodeOp,
  draft,
  freeze,
  mergeTextUpdates,
  type Doc,
  type DraftDoc,
  type FieldValue,
  type Op,
  type OpKind,
} from "@felix-canvas/model";

// Pending edits are overlaid at offsets past anything a log reaches, in the
// order they were made, so a local write wins over every delivered one until
// the log hands it back.
const LOCAL_OFFSET = 2 ** 52;

/** One of this session's edits the log has not delivered back yet. */
export interface PendingEdit {
  op: Op;
  /** When it was last handed to the gateway, by `performance.now()`; `null` if not yet. */
  sentAt: number | null;
}

interface Buffered {
  skippedBefore: number;
  payload: Uint8Array;
}

/**
 * A room's replica. `confirmed` is the fold of the op log in offset order;
 * the view adds this session's pending edits on top. The fold only moves
 * forward, so it runs in place, with live documents for the text bodies it
 * changes, and is frozen when someone reads it.
 *
 * Records are applied strictly in offset order, whatever order they arrive
 * in: one ahead of the next expected offset waits, and one already applied is
 * dropped. Repeats of an op at a new offset are absorbed by the fold's dedupe.
 * Figma's rule falls out of the overlay: a field with an unacknowledged local
 * write shows that write, and once the log delivers it the confirmed value is
 * the same one, so nothing flickers.
 */
export class Replica {
  readonly sid: bigint;
  #fold: DraftDoc = draft(EMPTY_DOC);
  #confirmed: Doc | null = EMPTY_DOC;
  #next = 0;
  readonly #ahead = new Map<number, Buffered>();
  readonly #pending: PendingEdit[] = [];
  #view: Doc | undefined;
  /** Called with each op as it enters the fold. */
  onApply: (op: Op) => void = () => {};

  constructor(sid: bigint) {
    this.sid = sid;
  }

  /** The state the log alone gives, up to {@link next}. */
  get confirmed(): Doc {
    return (this.#confirmed ??= freeze(this.#fold));
  }

  /** The next offset to apply: everything below it has been. */
  get next(): number {
    return this.#next;
  }

  /** Whether a record is waiting on offsets that have not arrived. */
  get hasGap(): boolean {
    return this.#ahead.size > 0;
  }

  get pending(): readonly PendingEdit[] {
    return this.#pending;
  }

  /**
   * What to draw: the confirmed state with pending edits on top. A body's
   * pending text ops are merged and applied once, where the first of them is.
   */
  view(): Doc {
    if (this.#view) return this.#view;
    const texts = new Map<bigint, Uint8Array[]>();
    for (const { op } of this.#pending) {
      if (op.kind === "text") texts.set(op.shape, [...(texts.get(op.shape) ?? []), textOf(op)]);
    }
    let doc = this.confirmed;
    for (const [i, { op }] of this.#pending.entries()) {
      if (op.kind !== "text") {
        doc = apply(doc, op, LOCAL_OFFSET + i);
        continue;
      }
      const updates = texts.get(op.shape);
      texts.delete(op.shape);
      if (updates) {
        doc = apply(doc, { ...op, fields: { y: mergeTextUpdates(updates) } }, LOCAL_OFFSET + i);
      }
    }
    return (this.#view = doc);
  }

  /** Show a local edit at once. It stays pending until the log delivers it. */
  edit(op: Op): void {
    this.#pending.push({ op, sentAt: null });
    this.#view = undefined;
  }

  /**
   * Fold an edit into one not sent yet, so a drag while disconnected queues
   * one op rather than one per frame, and typing one op per body. A patch
   * joins the newest pending edit if that is an unsent patch of `shape`; text
   * joins the newest unsent text op for `shape`, which is safe however many
   * edits to other shapes came after it, since only this body's text depends
   * on it. Returns whether it did.
   */
  amend(kind: OpKind, shape: bigint, fields: Record<string, FieldValue>): boolean {
    const unsent = (edit: PendingEdit) => edit.sentAt === null && edit.op.shape === shape;
    if (kind === "text") {
      const into = this.#pending.findLast((edit) => unsent(edit) && edit.op.kind === "text");
      if (!into) return false;
      const y = mergeTextUpdates([textOf(into.op), fields.y as Uint8Array]);
      into.op = { ...into.op, fields: { y } };
    } else {
      const last = this.#pending.at(-1);
      if (kind !== "patch" || !last || !unsent(last) || last.op.kind !== "patch") return false;
      last.op = { ...last.op, fields: { ...last.op.fields, ...fields } };
    }
    this.#view = undefined;
    return true;
  }

  /**
   * Take one record delivered at `offset`. Returns this session's edits that
   * it confirmed, which may include buffered records it unblocked.
   */
  deliver(offset: number, skippedBefore: number, payload: Uint8Array): PendingEdit[] {
    if (offset < this.#next || this.#ahead.has(offset)) return [];
    this.#ahead.set(offset, { skippedBefore, payload });
    return this.#drain();
  }

  /**
   * Replace the confirmed state with `doc`, a snapshot of the log below
   * `next`, and continue from there. Buffered records past it still apply.
   * Returns the pending edits the snapshot already holds, now confirmed, and
   * any that buffered records confirm.
   */
  reset(doc: Doc, next: number): PendingEdit[] {
    this.#fold = draft(doc);
    this.#confirmed = doc;
    this.#next = next;
    this.#view = undefined;
    for (const at of this.#ahead.keys()) if (at < next) this.#ahead.delete(at);
    const seq = doc.seqs.get(this.sid) ?? -1;
    const held = this.#pending.filter((edit) => edit.op.seq <= seq);
    this.#pending.splice(0, held.length);
    return [...held, ...this.#drain()];
  }

  #drain(): PendingEdit[] {
    const confirmed: PendingEdit[] = [];
    while (this.#ahead.size > 0) {
      const at = Math.min(...this.#ahead.keys());
      const record = this.#ahead.get(at)!;
      if (at - record.skippedBefore > this.#next) break;
      this.#ahead.delete(at);
      this.#next = at + 1;
      let op: Op;
      try {
        op = decodeOp(record.payload);
      } catch {
        // Not an op. The offset still counts as applied.
        continue;
      }
      applyInPlace(this.#fold, op, at);
      this.#confirmed = null;
      this.#view = undefined;
      this.onApply(op);
      if (op.sid === this.sid) {
        const mine = this.#pending.findIndex((edit) => edit.op.seq === op.seq);
        if (mine >= 0) confirmed.push(...this.#pending.splice(mine, 1));
      }
    }
    return confirmed;
  }
}

function textOf(op: Op): Uint8Array {
  return op.fields.y as Uint8Array;
}
