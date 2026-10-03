import { expect, test, type Browser, type Page } from "@playwright/test";

interface Replica {
  hash(): string;
  applied(): number;
  pending(): number;
  shapes(): number;
}

declare global {
  interface Window {
    felixCanvas: Replica;
  }
}

type Point = [number, number];

async function join(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await expect(page.locator("#joining")).toBeHidden({ timeout: 30_000 });
  return page;
}

function read(page: Page) {
  return page.evaluate(() => ({
    hash: window.felixCanvas.hash(),
    applied: window.felixCanvas.applied(),
    pending: window.felixCanvas.pending(),
    shapes: window.felixCanvas.shapes(),
  }));
}

async function draw(page: Page, tool: string, from: Point, to: Point): Promise<void> {
  await page.keyboard.press(tool);
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 12 });
  await page.mouse.up();
}

/** Wait until no page has an edit in flight and all have applied the same log prefix. */
async function settle(pages: Page[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const states = await Promise.all(pages.map(read));
        return states.every((s) => s.pending === 0 && s.applied === states[0]!.applied);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function hashes(pages: Page[]): Promise<string[]> {
  return Promise.all(pages.map(async (page) => (await read(page)).hash));
}

test("two browsers editing one room end with the same state hash", async ({ browser }) => {
  const ana = await join(browser);
  const ben = await join(browser);
  const before = (await read(ana)).shapes;

  await test.step("each sees the other's shapes", async () => {
    await draw(ana, "r", [300, 250], [460, 350]);
    await expect.poll(async () => (await read(ben)).shapes).toBe(before + 1);
    await draw(ben, "o", [700, 250], [840, 360]);
    await draw(ana, "p", [300, 520], [520, 580]);
    await draw(ben, "l", [700, 520], [900, 600]);
    await settle([ana, ben]);
    expect((await read(ana)).shapes).toBe(before + 4);
    expect(new Set(await hashes([ana, ben])).size).toBe(1);
  });

  await test.step("both drag the same rectangle at once", async () => {
    const centre: Point = [380, 300];
    await Promise.all([ana, ben].map((page) => page.keyboard.press("v")));
    await Promise.all([ana, ben].map((page) => page.mouse.move(...centre)));
    await Promise.all([ana, ben].map((page) => page.mouse.down()));
    await Promise.all([
      ana.mouse.move(centre[0] + 220, centre[1] + 40, { steps: 30 }),
      ben.mouse.move(centre[0] - 40, centre[1] + 160, { steps: 30 }),
    ]);
    await Promise.all([ana, ben].map((page) => page.mouse.up()));
    await settle([ana, ben]);
    const [first, second] = await hashes([ana, ben]);
    expect(second).toBe(first);
  });

  await test.step("a browser that joins later replays the same document", async () => {
    const cleo = await join(browser);
    await settle([ana, ben, cleo]);
    expect(new Set(await hashes([ana, ben, cleo])).size).toBe(1);
  });

  await expect(ana.locator("#chip-label")).toHaveText(/^Live · [\d.]+ ms$/);
});
