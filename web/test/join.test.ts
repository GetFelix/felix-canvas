import {
  EMPTY_DOC,
  apply,
  decodeOp,
  encodeOp,
  encodeSnapshot,
  stateHash,
  type Op,
} from "@felix-canvas/model";
import { describe, expect, it } from "vitest";

import { GatewayError, type GatewayEvent, type StreamName } from "../src/gateway.js";
import { Session, type Gateway } from "../src/session.js";

const other = 0x0dd0n;
const op = (seq: number): Op =>
  seq === 0
    ? {
        sid: other,
        seq,
        shape: 1n,
        kind: "create",
        fields: { type: "rect", x: 0, y: 0, w: 10, h: 10, z: "V" },
      }
    : { sid: other, seq, shape: 1n, kind: "patch", fields: { x: seq } };

/** One room's log, snapshot and retention point, shared by every fake connection. */
class Room {
  readonly log: Uint8Array[] = [];
  readonly connections = new Set<FakeGateway>();
  snapshotAt: number | null = null;
  oldest = 0;
  /** Runs while a snapshot read is in flight, before it is answered. */
  duringSnapshotRead: () => void = () => {};

  append(payload: Uint8Array): number {
    const offset = this.log.push(payload) - 1;
    for (const connection of this.connections) connection.deliver(offset);
    return offset;
  }

  write(count: number): void {
    for (let i = 0; i < count; i++) this.append(encodeOp(op(this.log.length)));
  }

  snapshot(): Uint8Array | null {
    if (this.snapshotAt === null) return null;
    const doc = this.log
      .slice(0, this.snapshotAt + 1)
      .reduce((state, bytes, offset) => apply(state, decodeOp(bytes), offset), EMPTY_DOC);
    return encodeSnapshot({ doc, offset: this.snapshotAt });
  }

  hash(): string {
    return stateHash(
      this.log.reduce((state, bytes, offset) => apply(state, decodeOp(bytes), offset), EMPTY_DOC),
    );
  }
}

/** The gateway as a session sees it, relaying one {@link Room}. */
class FakeGateway implements Gateway {
  onHello: Gateway["onHello"] = () => {};
  onEvent: Gateway["onEvent"] = () => {};
  onSubscribed: Gateway["onSubscribed"] = () => {};
  onError: Gateway["onError"] = () => {};
  onClose: Gateway["onClose"] = () => {};
  onMembers: Gateway["onMembers"] = () => {};
  onMember: Gateway["onMember"] = () => {};
  readonly requests: string[];
  #from: number | null = null;
  #counter = 0;

  constructor(
    readonly room: Room,
    requests: string[],
  ) {
    this.requests = requests;
    room.connections.add(this);
  }

  subscribe(stream: StreamName, from: number | "live"): void {
    if (stream !== "ops") return;
    this.requests.push(`subscribe ${from}`);
    setTimeout(() => {
      if (typeof from === "number" && from < this.room.oldest) {
        this.onError(new GatewayError("trimmed", `oldest is ${this.room.oldest}`), "ops");
        return;
      }
      const tail = this.room.log.length;
      this.#from = from === "live" ? tail : from;
      this.onSubscribed("ops", this.#from, tail);
      for (let offset = this.#from; offset < tail; offset++) this.deliver(offset);
    });
  }

  deliver(offset: number): void {
    if (this.#from === null || offset < this.#from) return;
    const event: GatewayEvent = {
      stream: "ops",
      offset,
      skippedBefore: 0,
      payload: this.room.log[offset]!,
    };
    this.onEvent(event);
  }

  async publish(stream: StreamName, payload: Uint8Array): Promise<number | null> {
    return stream === "ops" ? this.room.append(payload) : null;
  }

  async counterAdd(_key: string, delta: number): Promise<number> {
    return (this.#counter += delta);
  }

  async snapshot(): Promise<Uint8Array | null> {
    this.requests.push("snapshot");
    await new Promise((resolve) => setTimeout(resolve));
    this.room.duringSnapshotRead();
    return this.room.snapshot();
  }

  setMember(): void {}
  removeMember(): void {}
  watchMembers(): void {}

  close(): void {
    this.#from = null;
    this.room.connections.delete(this);
    this.onClose();
  }
}

function join(room: Room): { session: Session; requests: string[]; connections: FakeGateway[] } {
  const requests: string[] = [];
  const connections: FakeGateway[] = [];
  const session = new Session("ws://fake", async () => {
    const connection = new FakeGateway(room, requests);
    connections.push(connection);
    return connection;
  });
  session.start();
  return { session, requests, connections };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("joining a room", () => {
  it("keeps a change published while the snapshot is read, without reading the log again", async () => {
    const room = new Room();
    room.write(10);
    room.snapshotAt = 9;
    room.duringSnapshotRead = () => {
      room.duringSnapshotRead = () => {};
      room.write(1);
    };

    const { session, requests } = join(room);
    await until(() => session.caughtUp);

    expect(requests).toEqual(["subscribe live", "snapshot"]);
    expect(session.snapshotOffset).toBe(9);
    expect(session.replica.next).toBe(11);
    expect(stateHash(session.replica.confirmed)).toBe(room.hash());
  });

  it("reads the changes between an older snapshot and the tail", async () => {
    const room = new Room();
    room.write(10);
    room.snapshotAt = 4;

    const { session, requests } = join(room);
    await until(() => session.caughtUp);

    expect(requests).toEqual(["subscribe live", "snapshot", "subscribe 5"]);
    expect(stateHash(session.replica.confirmed)).toBe(room.hash());
  });

  it("reads the whole log when there is no snapshot yet", async () => {
    const room = new Room();
    room.write(6);

    const { session, requests } = join(room);
    expect(session.hasFrame).toBe(false);
    await until(() => session.caughtUp);

    expect(requests).toEqual(["subscribe live", "snapshot", "subscribe 0"]);
    expect(session.hasFrame).toBe(true);
    expect(stateHash(session.replica.confirmed)).toBe(room.hash());
  });

  it("rebuilds from the snapshot when its place in the log was trimmed, keeping unsaved edits", async () => {
    const room = new Room();
    room.write(5);
    const { session, requests, connections } = join(room);
    await until(() => session.caughtUp);

    connections[0]!.close();
    expect(session.submit("patch", 1n, { y: 42 })).toBe(true);
    room.write(20);
    room.snapshotAt = 19;
    room.oldest = 15;
    requests.length = 0;

    await until(() => session.rebuilding);
    await until(() => !session.rebuilding && session.replica.pending.length === 0);

    expect(requests).toEqual(["subscribe 5", "subscribe live", "snapshot", "subscribe 20"]);
    expect(session.caughtUp).toBe(true);
    expect(session.replica.confirmed.shapes.get(1n)?.fields.y).toBe(42);
    expect(stateHash(session.replica.confirmed)).toBe(room.hash());
  });
});
