import { expect, test, type Page } from "@playwright/test";

import { Writer, busyRoom, leaveAll, open, read } from "./helpers";

test.afterEach(leaveAll);

// About four times what a 4-core machine measures, so a slow runner does not
// fail it. Loading is per change because a rerun on the same stack finds the
// room's earlier changes too.
const LOAD_BUDGET_MS_PER_CHANGE = 0.5;
const SEEK_BUDGET_MS = 50;

const history = (page: Page) =>
  page.evaluate(() => {
    const h = window.felixCanvas.history;
    return { ready: h.ready(), position: h.position(), start: h.start(), end: h.end() };
  });

test("scrubbing a 10,000-change room shows exactly what the log held at each change", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // The studio room is this test's alone, so its history is the changes
  // written here: half of them typing into 50 text boxes.
  const tail = await busyRoom(10_000, 10, "studio", { text: true });
  const page = await open(browser, { room: "studio" });
  await expect(page.locator("#joining")).toBeHidden({ timeout: 60_000 });
  await expect.poll(async () => (await read(page)).applied, { timeout: 60_000 }).toBe(tail + 1);

  const opened = Date.now();
  await page.getByRole("button", { name: "History" }).click();
  await expect.poll(async () => (await history(page)).ready, { timeout: 60_000 }).toBe(true);
  const loadMs = Date.now() - opened;
  console.log(`history of ${tail + 1} changes ready after ${loadMs} ms`);
  expect(loadMs).toBeLessThan(Math.max(10_000, tail) * LOAD_BUDGET_MS_PER_CHANGE);

  // It opens at the newest change, which is the live canvas.
  const first = await history(page);
  expect(first.start).toBe(0);
  expect(first.end).toBe(tail + 1);
  expect(first.position).toBe(first.end);
  const live = await read(page);
  expect(await page.evaluate(() => window.felixCanvas.history.hash())).toBe(live.hash);
  await expect(page.locator("#toolbar")).toHaveCSS("opacity", "0");

  // Drag the playhead back and forth and check every stop against a fresh fold.
  const scale = (await page.locator("#history-scale").boundingBox())!;
  const y = scale.y + scale.height / 2;
  await page.mouse.move(scale.x + scale.width, y);
  await page.mouse.down();
  let seed = 11;
  for (let i = 0; i < 24; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    await page.mouse.move(scale.x + (seed / 2 ** 31) * scale.width, y, { steps: 4 });
    const { position } = await history(page);
    const [shown, fresh] = await page.evaluate(
      (at) => [window.felixCanvas.history.hash(), window.felixCanvas.history.freshHash(at)],
      position,
    );
    expect(shown, `change ${position}`).toBe(fresh);
  }
  await page.mouse.up();

  // The keyboard steps one change, or a hundred with Shift.
  const before = (await history(page)).position;
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  expect((await history(page)).position).toBe(Math.max(0, before - 101));
  await expect(page.locator("#history-change")).toContainText(
    `of ${(tail + 1).toLocaleString("en-US")}`,
  );

  const slowest = await page.evaluate(() => window.felixCanvas.history.slowestSeekMs());
  console.log(`slowest seek ${slowest.toFixed(1)} ms`);
  expect(slowest).toBeLessThan(SEEK_BUDGET_MS);

  // Someone keeps editing; the timeline grows and going back to live loses none of it.
  const writer = await Writer.open("studio");
  const shape = BigInt(Date.now()) << 64n;
  await writer.publish(shape, "create", { type: "rect", x: 0, y: 0, w: 40, h: 40, z: "V" });
  for (let i = 1; i < 5; i++) await writer.publish(shape, "patch", { x: i * 10 });
  writer.close();
  await expect(page.locator("#history-new")).toHaveText("+5 new");
  await page.getByRole("button", { name: "Back to live" }).click();
  await expect(page.locator("#history-bar")).toBeHidden();
  await expect.poll(async () => (await read(page)).applied).toBe(tail + 6);
  const after = await read(page);
  expect(after.shapes).toBe(live.shapes + 1);
});
