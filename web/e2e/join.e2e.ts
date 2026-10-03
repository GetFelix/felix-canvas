import { expect, test } from "@playwright/test";

import { Writer, hashes, join, leaveAll, read, settle } from "./helpers";

test.afterEach(leaveAll);

const SNAPSHOTTER = "http://127.0.0.1:8788/";

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
