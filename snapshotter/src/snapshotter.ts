import {
  EMPTY_DOC,
  applyInPlace,
  decodeOp,
  decodeSnapshot,
  draft,
  encodeSnapshot,
  freeze,
  pendingBodies,
  type DraftDoc,
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
  /** How long the group keeps a record claimed before handing it out again. */
  claimMs: number;
}

/** Records claimed per poll; the broker hands out at most 1,000 anyway. */
const POLL_MAX = 1000;
/** Snapshots past this size are logged, well before the broker's 16 MiB frame limit. */
const LARGE_SNAPSHOT = 4 * 1024 * 1024;

/**
 * Folds a room's op log, read through a consumer group, and keeps the result
 * in the room's snapshot.
 *
 * A record is acknowledged only once a stored snapshot covers it, so a crash
 * before the write makes the group hand the window out again. Records arrive
 * in offset order except for redeliveries, which are always of records already
 * folded, so anything at or below the last folded offset is skipped.
 *
 * A skipped text op leaves its body waiting for it, which the fold shows as
 * pending Yjs structures. Rather than save that, the snapshotter starts
 * again from the stored snapshot once the records it holds come back. If the
 * same wait shows up again, the log itself lacks what an author's update
 * depends on, and the snapshot is saved as every replica holds it.
 */
export class Snapshotter {
  readonly #log: RoomLog;
  readonly #schedule: Schedule;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #doc: DraftDoc = draft(EMPTY_DOC);
  #applied = -1;
  #saved = -1;
  #unsaved = 0;
  #unsavedSince = 0;
  #held: bigint[] = [];
  /** No polling before this time, so claimed records come back first. */
  #resumeAt = 0;
  /** Whether the fold has started again since the last snapshot was saved. */
  #retried = false;
  /** Bodies saved while waiting, and what they wait for, so the same wait is not retried. */
  #waiting = new Map<bigint, string>();

  constructor(
    log: RoomLog,
    schedule: Schedule,
    now: () => number = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {
    this.#log = log;
    this.#schedule = schedule;
    this.#now = now;
    this.#sleep = sleep;
  }

  /** The last offset folded, and the last one a stored snapshot holds; -1 for none. */
  get position(): { applied: number; saved: number } {
    return { applied: this.#applied, saved: this.#saved };
  }

  /** Continue from the stored snapshot, if there is one. */
  async start(): Promise<void> {
    const bytes = await this.#log.readSnapshot();
    const { doc, offset } = bytes ? decodeSnapshot(bytes) : { doc: EMPTY_DOC, offset: -1 };
    this.#doc = draft(doc);
    this.#applied = this.#saved = offset;
    this.#unsaved = 0;
  }

  /** Poll once, fold what arrived, and write and acknowledge when a snapshot is due. */
  async step(waitMs: number): Promise<void> {
    const resumeIn = this.#resumeAt - this.#now();
    if (resumeIn > 0) return this.#sleep(resumeIn);
    const records = await this.#log.poll(POLL_MAX, waitMs);
    records.sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
    for (const record of records) {
      this.#held.push(record.offset);
      const offset = Number(record.offset);
      if (offset <= this.#applied) continue;
      try {
        applyInPlace(this.#doc, decodeOp(record.payload), offset);
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
      const waiting = pendingBodies(this.#doc);
      const fresh = [...waiting].filter(([id, what]) => this.#waiting.get(id) !== what);
      if (fresh.length > 0 && !this.#retried) {
        console.warn(
          `snapshotter: a body is missing changes at offset ${this.#applied}; ` +
            "starting again from the stored snapshot",
        );
        this.#retried = true;
        this.#held = [];
        this.#resumeAt = this.#now() + this.#schedule.claimMs;
        return this.start();
      }
      if (fresh.length > 0) {
        console.warn(
          `snapshotter: a body is still missing changes at offset ${this.#applied}, ` +
            "so the log does not hold them; saving it as it is",
        );
      }
      for (const [id, what] of waiting) this.#waiting.set(id, what);
      const doc = freeze(this.#doc);
      for (const id of this.#waiting.keys()) if (!doc.texts.has(id)) this.#waiting.delete(id);
      const bytes = encodeSnapshot({ doc, offset: this.#applied });
      if (bytes.length > LARGE_SNAPSHOT) {
        console.warn(`snapshotter: the snapshot is ${bytes.length} bytes; Felix refuses 16 MiB`);
      }
      await this.#log.writeSnapshot(bytes);
      this.#saved = this.#applied;
      this.#unsaved = 0;
      this.#retried = false;
    }

    const done = this.#held.filter((offset) => offset <= BigInt(this.#saved));
    this.#held = this.#held.filter((offset) => offset > BigInt(this.#saved));
    await Promise.all(done.map((offset) => this.#log.ack(offset)));
  }
}
