import { History, decodeOp, decodeSnapshot, type Op } from "@felix-canvas/model";

import { GatewayClient, type GatewayEvent, type Join } from "./gateway.js";
import { LATEST, OPS, SNAPSHOTS } from "./session.js";

/** The part of {@link GatewayClient} the feed uses, so tests can stand in for it. */
export type HistoryGateway = Pick<
  GatewayClient,
  "onEvent" | "onSubscribed" | "onError" | "onClose" | "subscribe" | "cacheGet" | "close"
>;

const RETRY_MS = 1000;

/**
 * Reads a room's history into a {@link History} over a gateway connection of
 * its own, so the live session never pauses for it, and keeps reading new
 * changes while open. Nothing about it lives on the server: the history is
 * the log, read from its first offset, and closing ends the subscription.
 *
 * When retention has trimmed the start of the log, history starts at the
 * room's snapshot instead, which is the oldest state the log can still
 * rebuild.
 */
export class HistoryFeed {
  history: History | null = null;
  /** Whether the history has reached the tail the log had when it was opened. */
  loaded = false;
  /** The tail to reach before {@link loaded}: the first offset not yet written when opened. */
  target = 0;
  /** Called whenever the history grew or finished loading. */
  onChange: () => void = () => {};

  readonly #url: string;
  readonly #join: Join;
  readonly #connect: (url: string, join: Join) => Promise<HistoryGateway>;
  #client: HistoryGateway | null = null;
  #open = false;
  #subscribing = false;
  #trims = 0;

  constructor(
    url: string,
    join: Join,
    connect: (url: string, join: Join) => Promise<HistoryGateway> = GatewayClient.connect,
  ) {
    this.#url = url;
    this.#join = join;
    this.#connect = connect;
  }

  /** Start reading, or carry on from where an earlier read stopped. */
  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.loaded = false;
    this.target = 0;
    void this.#start();
  }

  close(): void {
    this.#open = false;
    const client = this.#client;
    this.#client = null;
    client?.close();
  }

  async #start(): Promise<void> {
    let client: HistoryGateway;
    try {
      client = await this.#connect(this.#url, this.#join);
    } catch {
      this.#retry();
      return;
    }
    if (!this.#open) {
      client.close();
      return;
    }
    this.#client = client;
    client.onSubscribed = (stream, _start, live) => {
      if (stream !== OPS) return;
      this.#subscribing = false;
      this.#trims = 0;
      if (!this.loaded) this.target = Math.max(this.target, live ?? 0);
      this.#checkLoaded();
    };
    client.onEvent = (event) => {
      if (event.stream === OPS) this.#deliver(client, event);
    };
    client.onError = (error, stream) => {
      if (stream !== OPS) return;
      if (error.code === "trimmed") {
        void this.#fromSnapshot(client);
      } else {
        setTimeout(() => this.#client === client && this.#subscribe(client), RETRY_MS);
      }
    };
    client.onClose = () => {
      if (this.#client !== client) return;
      this.#client = null;
      this.#retry();
    };
    this.#subscribe(client);
  }

  #retry(): void {
    setTimeout(() => {
      if (this.#open && !this.#client) void this.#start();
    }, RETRY_MS);
  }

  #subscribe(client: HistoryGateway): void {
    this.#subscribing = true;
    this.history ??= new History();
    client.subscribe(OPS, this.history.end);
  }

  async #fromSnapshot(client: HistoryGateway): Promise<void> {
    // A snapshot older than what retention kept is trimmed too; give the
    // snapshotter a moment rather than asking again at once.
    if (this.#trims++ > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    let snapshot = null;
    try {
      const bytes = await client.cacheGet(SNAPSHOTS, LATEST);
      snapshot = bytes && decodeSnapshot(bytes);
    } catch (error) {
      console.warn(`cannot read the snapshot history starts from: ${String(error)}`);
    }
    if (this.#client !== client) return;
    if (snapshot) this.history = new History(snapshot.doc, snapshot.offset + 1);
    this.#subscribe(client);
  }

  #deliver(client: HistoryGateway, event: GatewayEvent): void {
    const history = this.history;
    if (!history || event.offset === null || event.offset < history.end) return;
    if (event.offset - event.skippedBefore > history.end) {
      // Felix dropped records for this subscriber. Read them again from the log.
      if (!this.#subscribing) this.#subscribe(client);
      return;
    }
    while (history.end < event.offset) history.push(null);
    let op: Op | null = null;
    try {
      op = decodeOp(event.payload);
    } catch {
      // Not an op; the offset still counts.
    }
    history.push(op);
    this.#checkLoaded();
    this.onChange();
  }

  #checkLoaded(): void {
    if (this.loaded || this.#subscribing || !this.history) return;
    if (this.history.end >= this.target) {
      this.loaded = true;
      this.onChange();
    }
  }
}
