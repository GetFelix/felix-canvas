import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

interface Replica {
  hash(): string;
  applied(): number;
  pending(): number;
  shapes(): number;
  firstFrameMs(): number | null;
  snapshotOffset(): number | null;
}

declare global {
  interface Window {
    felixCanvas: Replica;
  }
}

const opened: BrowserContext[] = [];

/**
 * Open `room` in a fresh context, signed in through the development IdP as
 * `user`. With `name`, the page uses it as its display name. Returns once the
 * page is back from signing in, joined or not.
 */
export async function open(
  browser: Browser,
  {
    user = "ana",
    room = "lobby",
    name,
  }: { user?: string; room?: string; name?: string | undefined } = {},
): Promise<Page> {
  const context = await browser.newContext();
  opened.push(context);
  if (name) {
    await context.addInitScript((saved) => localStorage.setItem("felix-canvas.name", saved), name);
  }
  const page = await context.newPage();
  await page.goto(`/?room=${room}`);
  await page.getByRole("link", { name: `Continue as ${user}` }).click();
  await page.waitForURL(`**/?room=${room}`);
  return page;
}

/** Open the lobby as {@link open} does and wait until it shows a correct frame. */
export async function join(browser: Browser, name?: string): Promise<Page> {
  const page = await open(browser, { name });
  await expect(page.locator("#joining")).toBeHidden({ timeout: 30_000 });
  return page;
}

/**
 * Close every context {@link join} opened. The browser outlives each test,
 * and so would its tabs, still in the room.
 */
export async function leaveAll(): Promise<void> {
  await Promise.all(opened.splice(0).map((context) => context.close()));
}

export function read(page: Page) {
  return page.evaluate(() => ({
    hash: window.felixCanvas.hash(),
    applied: window.felixCanvas.applied(),
    pending: window.felixCanvas.pending(),
    shapes: window.felixCanvas.shapes(),
    firstFrameMs: window.felixCanvas.firstFrameMs(),
    snapshotOffset: window.felixCanvas.snapshotOffset(),
  }));
}

/** Wait until no page has an edit in flight and all have applied the same log prefix. */
export async function settle(pages: Page[], timeout = 15_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const states = await Promise.all(pages.map(read));
        return states.every((s) => s.pending === 0 && s.applied === states[0]!.applied);
      },
      { timeout },
    )
    .toBe(true);
}

export async function hashes(pages: Page[]): Promise<string[]> {
  return Promise.all(pages.map(async (page) => (await read(page)).hash));
}
