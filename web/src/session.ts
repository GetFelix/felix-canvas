import {
  EMPTY_DOC,
  MAX_U32,
  decodePresence,
  decodeSnapshot,
  encodeMember,
  encodeOp,
  encodePresence,
  randomSessionId,
  type FieldValue,
  type Member,
  type OpKind,
  type Presence,
} from "@felix-canvas/model";

import { GatewayClient, type GatewayEvent, type Join } from "./gateway.js";
import { Members, memberKey } from "./members.js";

/** The part of {@link GatewayClient} a session uses, so tests can stand in for it. */
export type Gateway = Pick<
  GatewayClient,
  | "onHello"
  | "onEvent"
  | "onSubscribed"
  | "onError"
  | "onClose"
  | "subscribe"
  | "publish"
  | "counterAdd"
  | "snapshot"
  | "onMembers"
  | "onMember"
  | "setMember"
  | "removeMember"
  | "watchMembers"
  | "throttle"
  | "close"
>;
import { Replica, type PendingEdit } from "./replica.js";

/** Seqs reserved from the counter at a time. Another block is fetched at half. */
const SEQ_BLOCK = 1024;
const RETRY_MS = [250, 500, 1000, 2000, 4000];
/** How long a peer may be ahead before this session decides its newest changes were lost. */
const PEER_AHEAD_GRACE_MS = 2000;
/** The slow link the throttle switch stands in for. */
export const THROTTLE_BITS_PER_SECOND = 100_000;

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
 *
 * Joining subscribes at the live tail before reading the snapshot, so a
 * change published while the snapshot is in flight is already queued here;
 * reading first would lose it. Buffered changes the snapshot holds are
 * dropped, the rest apply, and anything between the snapshot and the tail is
 * read with a second subscription from the snapshot's offset. A session whose
 * position has been trimmed from the log rejoins the same way.
 */
export class Session {
  readonly sid = randomSessionId();
  readonly replica = new Replica(this.sid);
  readonly members = new Members();
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
  /** Whether a correct frame can be drawn: a snapshot is applied, or the replica caught up. */
  hasFrame = false;
  /** Whether the log no longer holds this replica's position and it is starting again. */
  rebuilding = false;
  /** The log offset of the snapshot the session joined from, or `null` for none. */
  snapshotOffset: number | null = null;
  /** How many times changes went missing after the session had caught up. */
  fellBehind = 0;
  /** Whether the gateway is told to feed this session as if over a slow link. */
  throttled = false;

  /** Called when the replica's view may have changed. */
  onDocChange: () => void = () => {};
  /** Called when the connection, tail or room changed. */
  onStatusChange: () => void = () => {};
  /** Called for each presence message from another session. */
  onPresence: (presence: Presence) => void = () => {};
  /** Called when someone joined or left the member list, or changed name or colour. */
  onMembersChange: () => void = () => {};

  /**
   * Why the gateway turned this session away for good: the sign-in is no
   * longer accepted, or this person may not open the room. `null` while it
   * is allowed in, or still finding out.
   */
  refused: "signed_out" | "forbidden" | null = null;

  readonly #url: string;
  readonly #join: Join;
  readonly #open: (url: string, join: Join) => Promise<Gateway>;
  #client: Gateway | null = null;
  #awaitingSnapshot = false;
  #seq = 0;
  #seqEnd = 0;
  #reserving = false;
  #resubscribing = false;
  /** The offset the current ops subscription should deliver next. */
  #expected = 0;
  /** The oldest peer report of changes this session has not got, and when it came. */
  #peerAhead: { applied: number; at: number } | null = null;
  #retries = 0;
  #presenceSent = { n: 0, at: 0 };
  #member: Member | null = null;
  #refresh: { worker: Worker; everyMs: number } | null = null;

  constructor(
    url: string,
    join: Join,
    open: (url: string, join: Join) => Promise<Gateway> = GatewayClient.connect,
  ) {
    this.#url = url;
    this.#join = join;
    this.#open = open;
  }

  /** Whether the session is waiting for the snapshot to join from. */
  get loading(): boolean {
    return this.#awaitingSnapshot;
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
    this.replica.edit({ sid: this.sid, seq: this.#seq++, shape, kind, fields, at: Date.now() });
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
    const message = { ...presence, sid: this.sid, n, applied: this.replica.next };
    void this.#client.publish("presence", encodePresence(message), false);
  }

  /** Join the member list as `member`, or update the entry. It is refreshed until {@link leave}. */
  setMember(member: Member): void {
    const same = this.#member;
    if (
      same?.name === member.name &&
      same.color === member.color &&
      same.person === member.person
    ) {
      return;
    }
    this.#member = member;
    this.#writeMember();
  }

  /** Feed this session as if over a slow link, or at full speed again. */
  setThrottled(throttled: boolean): void {
    this.throttled = throttled;
    this.#client?.throttle(throttled ? THROTTLE_BITS_PER_SECOND : null);
    this.onStatusChange();
  }

  /** Leave the member list at once, for a tab that is closing. */
  leave(): void {
    this.#member = null;
    const key = memberKey(this.sid);
    // The socket message keeps order with a refresh still queued; the beacon
    // is what survives the page unloading.
    this.#client?.removeMember(key);
    navigator.sendBeacon(
      new URL("/members/leave", this.#url.replace(/^ws/, "http")),
      JSON.stringify({ ...this.#join, key }),
    );
  }

  /** Drop member entries past their deadline. */
  expireMembers(now = performance.now()): void {
    if (this.members.expire(now)) this.onMembersChange();
  }

  #writeMember(): void {
    if (this.#client && this.#member) {
      this.#client.setMember(memberKey(this.sid), encodeMember(this.#member));
    }
  }

  #refreshMemberEvery(everyMs: number): void {
    if (this.#refresh?.everyMs === everyMs) return;
    this.#refresh?.worker.terminate();
    // Chrome slows a hidden tab's timers to once a minute, slower than an
    // entry expires. A worker's timers keep their pace.
    const source = `setInterval(() => postMessage(0), ${everyMs})`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    worker.onmessage = () => this.#writeMember();
    this.#refresh = { worker, everyMs };
  }

  async #connect(): Promise<void> {
    let client: Gateway;
    try {
      client = await this.#open(this.#url, this.#join);
    } catch {
      this.#retry();
      return;
    }
    this.#client = client;
    client.onHello = (namespace, room, memberTtlMs) => {
      this.room = { namespace, room };
      this.#refreshMemberEvery(Math.max(1000, Math.floor(memberTtlMs / 3)));
      this.onStatusChange();
    };
    client.onMembers = (entries) => {
      this.members.reset(entries, performance.now());
      this.onMembersChange();
    };
    client.onMember = (entry) => {
      if (this.members.apply(entry, performance.now())) this.onMembersChange();
    };
    client.onSubscribed = (stream, start, live) => {
      if (stream !== "ops") return;
      this.#resubscribing = false;
      this.#expected = start ?? live ?? 0;
      this.#retries = 0;
      this.connection = "live";
      this.tail = Math.max(this.tail, (live ?? 0) - 1);
      if (this.#awaitingSnapshot) void this.#loadSnapshot(client);
      this.#checkCaughtUp();
      this.onStatusChange();
    };
    client.onEvent = (event) => {
      if (event.stream === "ops") this.#deliver(event);
      else this.#presence(event);
    };
    client.onError = (error, stream) => {
      if (stream === "ops") {
        // Wait first, so a subscription Felix keeps refusing is not retried in
        // a tight loop. The first trim goes straight to rebuilding.
        const wait = error.code === "trimmed" && !this.rebuilding ? 0 : 1000;
        if (error.code === "trimmed") this.#startRebuild();
        setTimeout(() => {
          if (this.#client !== client) return;
          this.#resubscribing = false;
          this.#subscribeOps(client);
        }, wait);
      } else if (error.code === "signed_out" || error.code === "forbidden") {
        this.refused = error.code;
        this.onStatusChange();
      } else if (error.code === "watch_failed") {
        setTimeout(() => {
          if (this.#client === client) client.watchMembers();
        }, 1000);
      }
      console.warn(`gateway: ${error.code}: ${error.message}`);
    };
    client.onClose = () => {
      if (this.#client !== client) return;
      this.#client = null;
      // Trying again would only be refused again.
      if (this.refused) return;
      this.connection = "reconnecting";
      this.onStatusChange();
      this.#retry();
    };

    if (this.throttled) client.throttle(THROTTLE_BITS_PER_SECOND);
    this.#subscribeOps(client);
    client.subscribe("presence", "live");
    client.watchMembers();
    this.#writeMember();
    // Resend before anything new, so this session's ops keep reaching the
    // log in seq order. The fold's dedupe absorbs any that landed already.
    for (const edit of this.replica.pending) this.#send(edit);
    await this.#reserveSeqs();
  }

  #subscribeOps(client: Gateway): void {
    if (this.rebuilding || this.replica.next === 0) {
      this.#awaitingSnapshot = true;
      client.subscribe("ops", "live");
    } else {
      client.subscribe("ops", this.replica.next);
    }
  }

  #startRebuild(): void {
    this.rebuilding = true;
    this.caughtUp = false;
    this.onStatusChange();
  }

  async #loadSnapshot(client: Gateway): Promise<void> {
    let bytes: Uint8Array | null;
    try {
      bytes = await client.snapshot();
    } catch (error) {
      console.warn(`cannot read the snapshot: ${String(error)}`);
      setTimeout(() => this.#client === client && this.#subscribeOps(client), 1000);
      return;
    }
    if (this.#client !== client || !this.#awaitingSnapshot) return;
    this.#awaitingSnapshot = false;
    let snapshot = null;
    try {
      snapshot = bytes && decodeSnapshot(bytes);
    } catch (error) {
      console.warn(`ignoring an unreadable snapshot: ${String(error)}`);
    }
    if (snapshot || this.rebuilding) {
      const doc = snapshot?.doc ?? EMPTY_DOC;
      const next = snapshot ? snapshot.offset + 1 : 0;
      this.#confirmed(this.replica.reset(doc, next));
      this.snapshotOffset = snapshot?.offset ?? null;
      this.hasFrame ||= snapshot !== null;
      this.tail = Math.max(this.tail, this.replica.next - 1);
    }
    // The live subscription began at the tail; read what lies between.
    if (this.replica.next <= this.tail) this.#resubscribe();
    this.#checkCaughtUp();
    this.onDocChange();
    this.onStatusChange();
  }

  #confirmed(edits: PendingEdit[]): void {
    const now = performance.now();
    for (const edit of edits) {
      if (edit.sentAt !== null) this.editTrips.add(now - edit.sentAt);
    }
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
    // Judged against the subscription, not the replica: records still held
    // from before a resubscribe sit ahead of the replica without a new drop.
    // Events that arrive while a resubscribe is pending are from the old one.
    const dropped = !this.#resubscribing && event.offset - event.skippedBefore > this.#expected;
    this.#expected = event.offset + 1;
    this.#confirmed(this.replica.deliver(event.offset, event.skippedBefore, event.payload));
    this.tail = Math.max(this.tail, event.offset);
    // While the snapshot is in flight, it decides where to read from.
    if (dropped && !this.#awaitingSnapshot) this.#lost();
    this.#checkCaughtUp();
    this.onDocChange();
  }

  #lost(): void {
    if (this.caughtUp) {
      this.caughtUp = false;
      this.fellBehind++;
      this.onStatusChange();
    }
    this.#resubscribe();
  }

  // Felix drops new records for a slow reader, so when the newest ones are
  // dropped nothing arrives after them to show the gap. Peers say in their
  // presence how far they have read; a claim still unmet after a grace period
  // is that loss.
  #peerApplied(applied: number | undefined): void {
    const now = performance.now();
    const ahead = this.#peerAhead;
    if (ahead && this.replica.next >= ahead.applied) {
      this.#peerAhead = null;
    } else if (ahead && this.caughtUp && now - ahead.at > PEER_AHEAD_GRACE_MS) {
      this.#peerAhead = null;
      this.tail = Math.max(this.tail, ahead.applied - 1);
      this.#lost();
    }
    if (applied !== undefined && applied > this.replica.next) {
      this.#peerAhead ??= { applied, at: now };
    }
  }

  // A gap means Felix dropped records for this subscriber because it read too
  // slowly. Subscribing again from the next offset fetches them from the log.
  #resubscribe(): void {
    if (this.#resubscribing || !this.#client) return;
    this.#resubscribing = true;
    this.#client.subscribe("ops", this.replica.next);
  }

  #checkCaughtUp(): void {
    if (
      !this.caughtUp &&
      !this.#awaitingSnapshot &&
      this.connection === "live" &&
      this.replica.next > this.tail
    ) {
      this.caughtUp = true;
      this.hasFrame = true;
      this.rebuilding = false;
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
      this.#peerApplied(presence.applied);
      this.onPresence(presence);
    } else if (presence.n === this.#presenceSent.n) {
      this.cursorTrips.add(performance.now() - this.#presenceSent.at);
    }
  }
}
