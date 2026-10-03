import { decodeOp, encodeOp, plainText, textClientId } from "@felix-canvas/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { TypingBuffer } from "../src/coalesce.js";
import { Session } from "../src/session.js";
import { FakeGateway, Room, until } from "./fake-gateway.js";

/**
 * A document typed into as the editor does, one character per keystroke.
 * `start` is the update that made its empty paragraph.
 */
function keyboard(sid = 1n) {
  const doc = new Y.Doc();
  doc.clientID = textClientId(sid);
  const body = doc.getXmlFragment("body");
  const p = new Y.XmlElement("p");
  p.insert(0, [new Y.XmlText()]);
  body.insert(0, [p]);
  const run = p.get(0) as Y.XmlText;
  return {
    doc,
    start: Y.encodeStateAsUpdateV2(doc),
    type(text: string) {
      run.insert(run.length, text);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TypingBuffer", () => {
  it("sends at most 7 ops a second for typing at 10 keys a second", () => {
    vi.useFakeTimers();
    const sent: { at: number; update: Uint8Array }[] = [];
    const buffer = new TypingBuffer((update) => sent.push({ at: Date.now(), update }));
    const { doc, start: first, type } = keyboard();
    doc.on("updateV2", (update: Uint8Array) => buffer.add(update));
    const start = Date.now();
    for (let key = 0; key < 600; key++) {
      type(String.fromCharCode(97 + (key % 26)));
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(1000);

    const perSecond = new Map<number, number>();
    for (const { at } of sent) {
      const second = Math.floor((at - start) / 1000);
      perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
    }
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(7);
    // Every keystroke arrives, in the merged updates.
    const copy = new Y.Doc();
    Y.applyUpdateV2(copy, first);
    for (const { update } of sent) Y.applyUpdateV2(copy, update);
    expect(copy.getXmlFragment("body").toString()).toBe(doc.getXmlFragment("body").toString());
  });

  it("sends a paste at once, and the rest when flushed", () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    const buffer = new TypingBuffer((update) => sent.push(update));
    const { doc, type } = keyboard();
    doc.on("updateV2", (update: Uint8Array) => buffer.add(update));
    type("x".repeat(9000));
    expect(sent.length).toBe(1);
    type("y");
    expect(sent.length).toBe(1);
    buffer.flush();
    expect(sent.length).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBe(2);
  });

  it("stamps an op with its first keystroke", () => {
    vi.useFakeTimers();
    let stamped = 0;
    const buffer = new TypingBuffer((_update, firstAt) => (stamped = firstAt));
    const { doc, type } = keyboard();
    doc.on("updateV2", (update: Uint8Array) => buffer.add(update));
    const first = Date.now();
    type("a");
    vi.advanceTimersByTime(100);
    type("b");
    vi.advanceTimersByTime(100);
    expect(stamped).toBe(first);
  });
});

describe("typing while offline", () => {
  it("queues one op per body however long it lasts, and sends them on reconnecting", async () => {
    const room = new Room();
    room.append(encodeOp({ sid: 9n, seq: 0, shape: 1n, kind: "create", fields: { type: "rect" } }));
    room.append(encodeOp({ sid: 9n, seq: 1, shape: 2n, kind: "create", fields: { type: "text" } }));
    let online = true;
    const connections: FakeGateway[] = [];
    const session = new Session("ws://fake", { room: "lobby", token: "t" }, async () => {
      if (!online) throw new Error("offline");
      const connection = new FakeGateway(room, []);
      connections.push(connection);
      return connection;
    });
    session.start();
    await until(() => session.caughtUp && connections.length === 1);
    online = false;
    connections[0]!.close();

    const bodies = [keyboard(session.sid), keyboard(session.sid)];
    for (const [i, { doc, start }] of bodies.entries()) {
      session.submit("text", BigInt(i + 1), { y: start });
      doc.on("updateV2", (y: Uint8Array) => session.submit("text", BigInt(i + 1), { y }));
    }
    // Ten minutes of typing flushed every 150 ms, two flushes in one box, then two in the other.
    for (let flush = 0; flush < 4_000; flush++) bodies[flush % 4 < 2 ? 0 : 1]!.type("k");
    expect(session.replica.pending.map(({ op }) => op.kind)).toEqual(["text", "text"]);

    online = true;
    await until(() => session.replica.pending.length === 0);
    const sent = room.log.slice(2).map((bytes) => decodeOp(bytes));
    expect(sent.map((op) => op.shape)).toEqual([1n, 2n]);
    for (const shape of [1n, 2n]) {
      const text = plainText(session.replica.confirmed.texts.get(shape)!.content);
      expect(text).toBe("k".repeat(2_000));
    }
  });
});
