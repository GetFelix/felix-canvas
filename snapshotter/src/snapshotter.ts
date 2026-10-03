import {
  EMPTY_DOC,
  apply,
  decodeOp,
  decodeSnapshot,
  encodeSnapshot,
  type Doc,
} from "@felix-canvas/model";

/** One record handed out by the consumer group. */
export interface GroupRecord {
  offset: bigint;
  payload: Uint8Array;
}

/** What the snapshotter needs from Felix, for one room. */
export interface RoomLog {
  /** Claim up to `max` records from the group, waiting up to `waitMs` for one. */
  poll(max: number, waitMs: number): Promise<GroupRecord[]>;
  /** Finish a record so the group never hands it out again. */
  ack(offset: bigint): Promise<void>;
  readSnapshot(): Promise<Uint8Array | null>;
  writeSnapshot(bytes: Uint8Array): Promise<void>;
}

export interface Schedule {
  /** Write a snapshot once this many records are folded but not yet saved. */
  everyOps: number;
  /** Or once the oldest unsaved record has waited this long. */
  everyMs: number;
}

/** Records claimed per poll; the broker hands out at most 1,000 anyway. */
const POLL_MAX = 1000;

/**
 * Folds a room's op log, read through a consumer group, and keeps the result
 * in the room's snapshot.
 *
 * A record is acknowledged only once a stored snapshot covers it, so a crash
 * before the write makes the group hand the window out again. Records arrive
 * in offset order except for redeliveries, which are always of records already
 * folded, so anything at or below the last folded offset is skipped.
 */
export class Snapshotter {
  readonly #log: RoomLog;
  readonly #schedule: Schedule;
  readonly #now: () => number;
  #doc: Doc = EMPTY_DOC;
  #applied = -1;
  #saved = -1;
  #unsaved = 0;
  #unsavedSince = 0;
  #held: bigint[] = [];

  constructor(log: RoomLog, schedule: Schedule, now: () => number = Date.now) {
    this.#log = log;
    this.#schedule = schedule;
    this.#now = now;
  }

  /** The last offset folded, and the last one a stored snapshot holds; -1 for none. */
  get position(): { applied: number; saved: number } {
    return { applied: this.#applied, saved: this.#saved };
  }

  /** Continue from the stored snapshot, if there is one. */
  async start(): Promise<void> {
    const bytes = await this.#log.readSnapshot();
    if (!bytes) return;
    const { doc, offset } = decodeSnapshot(bytes);
    this.#doc = doc;
    this.#applied = this.#saved = offset;
  }

  /** Poll once, fold what arrived, and write and acknowledge when a snapshot is due. */
  async step(waitMs: number): Promise<void> {
    const records = await this.#log.poll(POLL_MAX, waitMs);
    records.sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
    for (const record of records) {
      this.#held.push(record.offset);
      const offset = Number(record.offset);
      if (offset <= this.#applied) continue;
      try {
        this.#doc = apply(this.#doc, decodeOp(record.payload), offset);
      } catch {
        // Not an op. The offset still counts as folded.
      }
      this.#applied = offset;
      if (this.#unsaved++ === 0) this.#unsavedSince = this.#now();
    }

    const due =
      this.#unsaved >= this.#schedule.everyOps ||
      (this.#unsaved > 0 && this.#now() - this.#unsavedSince >= this.#schedule.everyMs);
    if (due) {
      await this.#log.writeSnapshot(encodeSnapshot({ doc: this.#doc, offset: this.#applied }));
      this.#saved = this.#applied;
      this.#unsaved = 0;
    }

    const done = this.#held.filter((offset) => offset <= BigInt(this.#saved));
    this.#held = this.#held.filter((offset) => offset > BigInt(this.#saved));
    await Promise.all(done.map((offset) => this.#log.ack(offset)));
  }
}
