import { decodeOp, encodePresence, stateHash } from "@felix-canvas/model";
import { describe, expect, it, vi } from "vitest";

import { GatewayError } from "../src/gateway.js";
import { Session } from "../src/session.js";
import { FakeGateway, Room, other, until } from "./fake-gateway.js";

function join(room: Room): { session: Session; requests: string[]; connections: FakeGateway[] } {
  const requests: string[] = [];
  const connections: FakeGateway[] = [];
  const session = new Session("ws://fake", { room: "lobby", token: "t" }, async () => {
    const connection = new FakeGateway(room, requests);
    connections.push(connection);
    return connection;
  });
  session.start();
  return { session, requests, connections };
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

describe("a refused join", () => {
  it("stops the session instead of reconnecting", async () => {
    let opened = 0;
    const session = new Session("ws://fake", { room: "studio", token: "t" }, async () => {
      opened++;
      const connection = new FakeGateway(new Room(), []);
      setTimeout(() => {
        connection.onError(new GatewayError("forbidden", "not a member of this room"));
        connection.close();
      });
      return connection;
    });
    session.start();
    await until(() => session.refused !== null);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(session.refused).toBe("forbidden");
    expect(opened).toBe(1);
  });
});

describe("falling behind", () => {
  it("catches up from the last applied change when changes go missing", async () => {
    const room = new Room();
    room.write(5);
    const { session, requests, connections } = join(room);
    await until(() => session.caughtUp);

    connections[0]!.dropping = true;
    room.write(3);
    connections[0]!.dropping = false;
    requests.length = 0;
    room.write(1);
    expect(session.caughtUp).toBe(false);
    expect(session.fellBehind).toBe(1);

    await until(() => session.caughtUp);
    expect(requests).toEqual(["subscribe 5"]);
    expect(session.replica.next).toBe(9);
    expect(session.fellBehind).toBe(1);
    expect(stateHash(session.replica.confirmed)).toBe(room.hash());
  });

  it("learns from a peer when its newest changes were lost with nothing after them", async () => {
    const room = new Room();
    room.write(5);
    const { session, requests, connections } = join(room);
    await until(() => session.caughtUp);

    connections[0]!.dropping = true;
    room.write(3);
    connections[0]!.dropping = false;
    requests.length = 0;
    const peer = (applied: number) =>
      connections[0]!.onEvent({
        stream: "presence",
        offset: null,
        skippedBefore: 0,
        payload: encodePresence({
          sid: other,
          n: applied,
          name: "Ana",
          color: 0,
          cursor: null,
          selection: [],
          applied,
        }),
      });
    const now = performance.now();
    const clock = vi.spyOn(performance, "now");
    try {
      clock.mockReturnValue(now);
      peer(8);
      clock.mockReturnValue(now + 1000);
      peer(8);
      expect(session.caughtUp).toBe(true);
      clock.mockReturnValue(now + 3000);
      peer(8);
      expect(session.caughtUp).toBe(false);
      expect(session.fellBehind).toBe(1);
    } finally {
      clock.mockRestore();
    }

    await until(() => session.caughtUp);
    expect(requests).toEqual(["subscribe 5"]);
    expect(stateHash(session.replica.confirmed)).toBe(room.hash());
  });

  it("does not count a gap while joining as falling behind", async () => {
    const room = new Room();
    room.write(10);
    room.snapshotAt = 4;
    const { session } = join(room);
    await until(() => session.caughtUp);
    expect(session.fellBehind).toBe(0);
  });

  it("keeps a reconnected session throttled", async () => {
    const room = new Room();
    const { session, requests, connections } = join(room);
    await until(() => session.caughtUp);

    session.setThrottled(true);
    expect(requests.at(-1)).toBe("throttle 100000");
    requests.length = 0;
    connections[0]!.close();
    await until(() => connections.length === 2 && session.caughtUp);
    expect(requests[0]).toBe("throttle 100000");

    session.setThrottled(false);
    expect(requests.at(-1)).toBe("throttle null");
  });
});

describe("losing the connection to the room", () => {
  it("sends unanswered edits again and keeps one copy of any that landed twice", async () => {
    const room = new Room();
    room.write(3);
    const { session, connections } = join(room);
    await until(() => session.caughtUp);

    // The record lands, but neither its ack nor its delivery reaches this session.
    connections[0]!.losingAcks = true;
    connections[0]!.dropping = true;
    session.submit("patch", 1n, { y: 7 });
    await until(() => connections.length === 2 && session.replica.pending.length === 0);

    const seqs = room.log.slice(3).map((bytes) => decodeOp(bytes).seq);
    expect(seqs.length).toBe(2);
    expect(new Set(seqs).size).toBe(1);
    expect(session.replica.next).toBe(5);
    expect(session.replica.confirmed.shapes.get(1n)?.fields.y).toBe(7);
    expect(stateHash(session.replica.confirmed)).toBe(room.hash());
  });

  it("asks for live cursors again when their subscription ends", async () => {
    const room = new Room();
    const { session, connections } = join(room);
    await until(() => session.caughtUp);
    const connection = connections[0]!;
    expect(connection.presenceSubscribes).toBe(1);

    connection.onError(new GatewayError("subscription_ended", "connection lost"), "presence");
    await until(() => connection.presenceSubscribes === 2);
  });
});
