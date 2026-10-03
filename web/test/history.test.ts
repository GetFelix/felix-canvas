import { stateHash } from "@felix-canvas/model";
import { describe, expect, it } from "vitest";

import { HistoryFeed } from "../src/history.js";
import { timeAgo } from "../src/scrubber.js";
import { FakeGateway, Room, until } from "./fake-gateway.js";

function feed(room: Room): { feed: HistoryFeed; requests: string[] } {
  const requests: string[] = [];
  const history = new HistoryFeed("ws://fake", { room: "lobby", token: "t" }, async () => {
    return new FakeGateway(room, requests);
  });
  history.open();
  return { feed: history, requests };
}

describe("reading a room's history", () => {
  it("reads the whole log, then keeps up with new changes", async () => {
    const room = new Room();
    room.write(40);
    const { feed: history, requests } = feed(room);
    await until(() => history.loaded);

    expect(requests).toEqual(["subscribe 0"]);
    expect(history.history!.start).toBe(0);
    expect(history.history!.end).toBe(40);
    expect(stateHash(history.history!.at(40))).toBe(room.hash());

    room.write(3);
    expect(history.history!.end).toBe(43);
    expect(stateHash(history.history!.at(43))).toBe(room.hash());
  });

  it("starts at the snapshot when retention trimmed the start of the log", async () => {
    const room = new Room();
    room.write(30);
    room.snapshotAt = 19;
    room.oldest = 15;
    const { feed: history, requests } = feed(room);
    await until(() => history.loaded);

    expect(requests).toEqual(["subscribe 0", "snapshot", "subscribe 20"]);
    expect(history.history!.start).toBe(20);
    expect(stateHash(history.history!.at(30))).toBe(room.hash());
  });

  it("reads records the broker dropped again instead of skipping them", async () => {
    const room = new Room();
    room.write(10);
    const connections: FakeGateway[] = [];
    const requests: string[] = [];
    const history = new HistoryFeed("ws://fake", { room: "lobby", token: "t" }, async () => {
      const connection = new FakeGateway(room, requests);
      connections.push(connection);
      return connection;
    });
    history.open();
    await until(() => history.loaded);
    connections[0]!.dropping = true;
    room.write(2);
    connections[0]!.dropping = false;
    room.write(1);
    await until(() => history.history!.end === 13);

    expect(requests).toEqual(["subscribe 0", "subscribe 10"]);
    expect(stateHash(history.history!.at(13))).toBe(room.hash());
  });

  it("carries on from where it stopped when opened again", async () => {
    const room = new Room();
    room.write(10);
    const { feed: history, requests } = feed(room);
    await until(() => history.loaded);
    history.close();
    room.write(5);

    history.open();
    expect(history.loaded).toBe(false);
    await until(() => history.loaded);
    expect(requests).toEqual(["subscribe 0", "subscribe 10"]);
    expect(history.history!.end).toBe(15);
  });
});

describe("timeAgo", () => {
  it("says how long ago in plain words", () => {
    expect(timeAgo(5_000)).toBe("Just now");
    expect(timeAgo(3 * 60_000)).toBe("3 minutes ago");
    expect(timeAgo(2 * 3_600_000)).toBe("2 hours ago");
    expect(timeAgo(26 * 3_600_000)).toBe("Yesterday");
  });
});
