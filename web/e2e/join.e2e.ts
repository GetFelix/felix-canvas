import { expect, test } from "@playwright/test";

import { Writer, busyRoom, hashes, join, leaveAll, read, settle } from "./helpers";

test.afterEach(leaveAll);

const SNAPSHOTTER = "http://127.0.0.1:8788/";

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
