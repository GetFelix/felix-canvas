import { EMPTY_DOC, applyInPlace, draft, freeze, type Doc, type DraftDoc } from "./doc.js";
import type { Op } from "./op.js";

/** Records between kept states. Seeking folds at most this many. */
const CHECKPOINT_EVERY = 256;

/**
 * A room's history: the records at consecutive log offsets from `start`, on
 * top of `base`, the room after every offset below `start`. {@link at} gives
 * the room as it was at any position in between, folded from the nearest
 * kept state, so it matches a fold of the whole log to that position.
 *
 * It folds in place and copies only at kept states and answers: copying a
 * document per op would make loading a long history take seconds. Text
 * bodies are live documents while folding, frozen with the state that holds
 * them, so a seek decodes only the bodies its ops touch.
 */
export class History {
  readonly start: number;
  readonly base: Doc;
  readonly #records: (Op | null)[] = [];
  /** The room at `start`, `start + CHECKPOINT_EVERY`, and so on. */
  readonly #kept: Doc[];
  readonly #head: DraftDoc;
  /** A copy of the head handed out, until the next record changes it. */
  #headCopy: Doc | null = null;
  #last: { position: number; doc: Doc };

  constructor(base: Doc = EMPTY_DOC, start = 0) {
    this.base = base;
    this.start = start;
    this.#kept = [base];
    this.#head = draft(base);
    this.#last = { position: start, doc: base };
  }

  /** One past the newest offset held, which is the position of the newest state. */
  get end(): number {
    return this.start + this.#records.length;
  }

  /** Append the record at offset {@link end}: an op, or `null` for anything else. */
  push(op: Op | null): void {
    if (op) {
      applyInPlace(this.#head, op, this.end);
      this.#headCopy = null;
    }
    this.#records.push(op);
    if (this.#records.length % CHECKPOINT_EVERY === 0) this.#kept.push(freeze(this.#head));
  }

  /** The op at `offset`, or `null` if that record is not one or is not held. */
  op(offset: number): Op | null {
    return this.#records[offset - this.start] ?? null;
  }

  /**
   * The room after every offset below `position`.
   *
   * @throws RangeError unless `start <= position <= end`.
   */
  at(position: number): Doc {
    if (!Number.isInteger(position) || position < this.start || position > this.end) {
      throw new RangeError(`position ${position} is outside ${this.start}..${this.end}`);
    }
    if (position === this.end) return (this.#headCopy ??= freeze(this.#head));
    const index = Math.floor((position - this.start) / CHECKPOINT_EVERY);
    let from = this.start + index * CHECKPOINT_EVERY;
    let start = this.#kept[index]!;
    // Stepping forward from the last answer is cheaper than the kept state.
    if (this.#last.position >= from && this.#last.position <= position) {
      ({ position: from, doc: start } = this.#last);
    }
    if (from === position) return start;
    const working = draft(start);
    for (; from < position; from++) {
      const op = this.#records[from - this.start];
      if (op) applyInPlace(working, op, from);
    }
    const doc = freeze(working);
    this.#last = { position, doc };
    return doc;
  }
}
