import { encodeOp, randomSessionId, type Op } from "@felix-canvas/model";
import { expect, test } from "@playwright/test";

import { hashes, join, leaveAll, read, settle } from "./helpers";

test.afterEach(leaveAll);

const GATEWAY = "ws://127.0.0.1:8787/ws";
const SNAPSHOTTER = "http://127.0.0.1:8788/";

/** A session that publishes ops over its own gateway connection, as a browser does. */
class Writer {
  readonly sid = randomSessionId();
  readonly #socket: WebSocket;
  readonly #acks = new Map<number, (offset: number) => void>();
  #seq = 0;
  #id = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (message) => {
      const reply = JSON.parse(String(message.data));
      if (reply.type === "ack") this.#acks.get(reply.id)?.(reply.offset);
      if (reply.type === "error") console.error(`gateway: ${reply.message}`);
    });
  }

  static open(): Promise<Writer> {
    const socket = new WebSocket(GATEWAY);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(new Writer(socket)), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
  }

  /** Publish an op and resolve with its log offset. */
  publish(shape: bigint, kind: Op["kind"], fields: Op["fields"]): Promise<number> {
    const id = this.#id++;
    const payload = encodeOp({ sid: this.sid, seq: this.#seq++, shape, kind, fields });
    this.#socket.send(
      JSON.stringify({
        type: "publish",
        stream: "ops",
        payload: Buffer.from(payload).toString("base64"),
        ack: true,
        id,
      }),
    );
    return new Promise((resolve) => this.#acks.set(id, resolve));
  }

  close(): void {
    this.#socket.close();
  }
}

/**
 * Fill the room with `count` ops from `sessions` writers: each creates a
 * few shapes well away from where the other test draws, then moves them.
 * Resolves with the last offset written.
 */
async function busyRoom(count: number, sessions: number): Promise<number> {
  const writers = await Promise.all(Array.from({ length: sessions }, () => Writer.open()));
  const offsets = await Promise.all(
    writers.map((writer, w) => {
      const shapes = Array.from({ length: 30 }, (_, i) => BigInt(w * 1000 + i + 1) << 64n);
      return Promise.all(
        Array.from({ length: count / sessions }, (_, i) => {
          const shape = shapes[i % shapes.length]!;
          const x = 2000 + (i % 30) * 60 + w * 8;
          const y = 2000 + w * 120 + (i % 7);
          return i < shapes.length
            ? writer.publish(shape, "create", { type: "rect", x, y, w: 40, h: 30, z: "V" })
            : writer.publish(shape, "patch", { x, y });
        }),
      );
    }),
  );
  for (const writer of writers) writer.close();
  return Math.max(...offsets.flat());
}

test("a cold browser joins a busy room from its snapshot and converges", async ({ browser }) => {
  test.setTimeout(180_000);
  const ana = await join(browser);

  const tail = await busyRoom(10_000, 10);
  await expect
    .poll(async () => ((await (await fetch(SNAPSHOTTER)).json()) as { saved: number }).saved, {
      timeout: 60_000,
    })
    .toBeGreaterThan(tail - 1000);

  // Someone keeps editing while the new browser joins.
  const editor = await Writer.open();
  let editing = true;
  const edits = (async () => {
    const shape = BigInt(Date.now()) << 64n;
    await editor.publish(shape, "create", {
      type: "ellipse",
      x: 2000,
      y: 1800,
      w: 50,
      h: 50,
      z: "V",
    });
    for (let i = 0; editing; i++) {
      await editor.publish(shape, "patch", { x: 2000 + (i % 200) });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();

  const cleo = await join(browser);
  const joined = await read(cleo);
  editing = false;
  await edits;
  editor.close();

  expect(joined.snapshotOffset).toBeGreaterThan(tail - 1000);
  expect(joined.firstFrameMs).not.toBeNull();
  expect(joined.firstFrameMs!).toBeLessThan(500);
  await settle([ana, cleo], 30_000);
  const [first, second] = await hashes([ana, cleo]);
  expect(second).toBe(first);
  console.log(`first correct frame after ${joined.firstFrameMs!.toFixed(0)} ms`);
});
