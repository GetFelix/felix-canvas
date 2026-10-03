import {
  MAX_U32,
  decodePresence,
  encodeOp,
  encodePresence,
  randomSessionId,
  type FieldValue,
  type OpKind,
  type Presence,
} from "@felix-canvas/model";

import { GatewayClient, type GatewayEvent } from "./gateway.js";
import { Replica, type PendingEdit } from "./replica.js";

/** Seqs reserved from the counter at a time. Another block is fetched at half. */
const SEQ_BLOCK = 1024;
const RETRY_MS = [250, 500, 1000, 2000, 4000];

export type Connection = "connecting" | "live" | "reconnecting";

/** Round-trip samples in milliseconds, newest last. */
export class RoundTrips {
  readonly #samples: { at: number; ms: number }[] = [];

  add(ms: number): void {
    this.#samples.push({ at: performance.now(), ms });
    if (this.#samples.length > 600) this.#samples.shift();
  }

  /** The `q` quantile of the samples from the last ten seconds, or `null` if none. */
  quantile(q: number): number | null {
    const since = performance.now() - 10_000;
    const recent = this.#samples
      .filter((sample) => sample.at >= since)
      .map((sample) => sample.ms)
      .sort((a, b) => a - b);
    if (recent.length === 0) return null;
    return recent[Math.min(recent.length - 1, Math.floor(q * recent.length))]!;
  }

  /** The newest `count` samples, oldest first. */
  latest(count: number): number[] {
    return this.#samples.slice(-count).map((sample) => sample.ms);
  }
}

/**
 * This browser's session in the room: one gateway connection, replaced when
 * it drops, feeding one {@link Replica}.
 */
export class Session {
  readonly sid = randomSessionId();
  readonly replica = new Replica(this.sid);
  /** Publish to own delivery on the op log. */
  readonly editTrips = new RoundTrips();
  /** The same on the presence stream. */
  readonly cursorTrips = new RoundTrips();
  room: { namespace: string; room: string } | null = null;
  connection: Connection = "connecting";
  /** The last offset known to be in the log, or -1 for an empty log. */
  tail = -1;
  /** Whether the replica has reached the tail the first subscription reported. */
  caughtUp = false;

  /** Called when the replica's view may have changed. */
  onDocChange: () => void = () => {};
  /** Called when the connection, tail or room changed. */
  onStatusChange: () => void = () => {};
  /** Called for each presence message from another session. */
  onPresence: (presence: Presence) => void = () => {};

  readonly #url: string;
  #client: GatewayClient | null = null;
  #seq = 0;
  #seqEnd = 0;
  #reserving = false;
  #resubscribing = false;
  #retries = 0;
  #presenceSent = { n: 0, at: 0 };

  constructor(url: string) {
    this.#url = url;
  }

  start(): void {
    void this.#connect();
  }

  /**
   * Make an edit: shown at once, then published. Returns `false` when it was
   * refused because no sequence number is free, which only happens after
   * hundreds of edits without a connection.
   */
  submit(kind: OpKind, shape: bigint, fields: Record<string, FieldValue>): boolean {
    if (kind === "patch" && this.replica.amend(shape, fields)) {
      this.onDocChange();
      return true;
    }
    if (this.#seq >= this.#seqEnd) return false;
    this.replica.edit({ sid: this.sid, seq: this.#seq++, shape, kind, fields });
    if (this.#client) this.#send(this.replica.pending.at(-1)!);
    void this.#reserveSeqs();
    this.onDocChange();
    return true;
  }

  /** Publish this session's cursor and selection, fire-and-forget. */
  publishPresence(presence: Omit<Presence, "sid" | "n">): void {
    if (!this.#client) return;
    const n = (this.#presenceSent.n + 1) % MAX_U32;
    this.#presenceSent = { n, at: performance.now() };
    void this.#client.publish("presence", encodePresence({ ...presence, sid: this.sid, n }), false);
  }

  async #connect(): Promise<void> {
    let client: GatewayClient;
    try {
      client = await GatewayClient.connect(this.#url);
    } catch {
      this.#retry();
      return;
    }
    this.#client = client;
    client.onHello = (namespace, room) => {
      this.room = { namespace, room };
      this.onStatusChange();
    };
    client.onSubscribed = (stream, _start, live) => {
      if (stream !== "ops") return;
      this.#resubscribing = false;
      this.#retries = 0;
      this.connection = "live";
      this.tail = Math.max(this.tail, (live ?? 0) - 1);
      this.#checkCaughtUp();
      this.onStatusChange();
    };
    client.onEvent = (event) => {
      if (event.stream === "ops") this.#deliver(event);
      else this.#presence(event);
    };
    client.onError = (error, stream) => {
      if (stream === "ops") {
        this.#resubscribing = false;
        this.#resubscribe();
      }
      console.warn(`gateway: ${error.code}: ${error.message}`);
    };
    client.onClose = () => {
      if (this.#client !== client) return;
      this.#client = null;
      this.connection = "reconnecting";
      this.onStatusChange();
      this.#retry();
    };

    client.subscribe("ops", this.replica.next);
    client.subscribe("presence", "live");
    // Resend before anything new, so this session's ops keep reaching the
    // log in seq order. The fold's dedupe absorbs any that landed already.
    for (const edit of this.replica.pending) this.#send(edit);
    await this.#reserveSeqs();
  }

  #retry(): void {
    const delay = RETRY_MS[Math.min(this.#retries++, RETRY_MS.length - 1)];
    setTimeout(() => void this.#connect(), delay);
  }

  #send(edit: PendingEdit): void {
    const client = this.#client!;
    edit.sentAt = performance.now();
    // A failed publish may or may not have landed. Reconnecting resends every
    // pending op in order, which keeps the seq-order rule the dedupe needs.
    client.publish("ops", encodeOp(edit.op)).catch(() => client.close());
  }

  async #reserveSeqs(): Promise<void> {
    const client = this.#client;
    if (!client || this.#reserving || this.#seqEnd - this.#seq >= SEQ_BLOCK / 2) return;
    this.#reserving = true;
    try {
      const end = await client.counterAdd(this.sid.toString(16).padStart(16, "0"), SEQ_BLOCK);
      if (end <= MAX_U32 + 1) {
        this.#seq = end - SEQ_BLOCK;
        this.#seqEnd = end;
      }
    } catch (error) {
      console.warn(`cannot reserve sequence numbers: ${String(error)}`);
    } finally {
      this.#reserving = false;
    }
  }

  #deliver(event: GatewayEvent): void {
    if (event.offset === null) return;
    const now = performance.now();
    for (const edit of this.replica.deliver(event.offset, event.skippedBefore, event.payload)) {
      if (edit.sentAt !== null) this.editTrips.add(now - edit.sentAt);
    }
    this.tail = Math.max(this.tail, event.offset);
    if (this.replica.hasGap) this.#resubscribe();
    this.#checkCaughtUp();
    this.onDocChange();
  }

  // A gap means the broker dropped records for this subscriber. Subscribing
  // again from the next offset fetches them from the log.
  #resubscribe(): void {
    if (this.#resubscribing || !this.#client) return;
    this.#resubscribing = true;
    this.#client.subscribe("ops", this.replica.next);
  }

  #checkCaughtUp(): void {
    if (!this.caughtUp && this.connection === "live" && this.replica.next > this.tail) {
      this.caughtUp = true;
      this.onStatusChange();
    }
  }

  #presence(event: GatewayEvent): void {
    let presence: Presence;
    try {
      presence = decodePresence(event.payload);
    } catch {
      return;
    }
    if (presence.sid !== this.sid) {
      this.onPresence(presence);
    } else if (presence.n === this.#presenceSent.n) {
      this.cursorTrips.add(performance.now() - this.#presenceSent.at);
    }
  }
}
