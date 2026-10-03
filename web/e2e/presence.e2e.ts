import { expect, test, type Page } from "@playwright/test";

import { join, leaveAll } from "./helpers";

test.afterEach(leaveAll);

/** The member TTL the Playwright config gives the gateway. */
const MEMBER_TTL_MS = 6_000;

function cursorOf(page: Page, name: string) {
  return page.locator(".cursor", { has: page.locator(".cursor-name", { hasText: name }) });
}

function personIn(page: Page, name: string) {
  return page.locator("#people-list .person-name", { hasText: new RegExp(`^${name}$`) });
}

/** Wait until `name`'s cursor is shown on `page` at screen point `at`. */
async function expectCursorAt(page: Page, name: string, at: [number, number]): Promise<void> {
  const cursor = cursorOf(page, name);
  await expect(cursor).not.toHaveClass(/hidden/);
  await expect
    .poll(async () => {
      const box = await cursor.boundingBox();
      return box !== null && Math.hypot(box.x - at[0], box.y - at[1]) < 4;
    })
    .toBe(true);
}

test("two people see each other's cursors and names, and a vanished tab drops out", async ({
  browser,
}) => {
  const ana = await join(browser, "Ana");
  const ben = await join(browser, "Ben");

  await test.step("each sees the other's cursor follow their pointer", async () => {
    await ana.mouse.move(400, 300);
    await ana.mouse.move(460, 340, { steps: 8 });
    await expectCursorAt(ben, "Ana", [460, 340]);
    await ben.mouse.move(800, 420, { steps: 8 });
    await expectCursorAt(ana, "Ben", [800, 420]);
  });

  await test.step("each is in the other's people list", async () => {
    for (const [page, other] of [
      [ana, "Ben"],
      [ben, "Ana"],
    ] as const) {
      await page.locator("#avatars").click();
      await expect(page.locator("#people-title")).toHaveText(/^\d+ people here$/);
      await expect(personIn(page, other)).toHaveCount(1);
      await page.keyboard.press("Escape");
      // Tabs the previous test closed without a goodbye can push someone
      // into the "+N" pill until their entries expire.
      await expect(page.locator(`#avatars .avatar[data-tip="${other}"]`)).toHaveCount(1, {
        timeout: MEMBER_TTL_MS + 4_000,
      });
    }
  });

  await test.step("a reload keeps one entry and the same colour", async () => {
    const colorOfAna = () =>
      ben
        .locator('#avatars .avatar[data-tip^="Ana"]')
        .evaluate((avatar) => (avatar as HTMLElement).style.getPropertyValue("--peer"));
    // An earlier test's tab named Ana is someone else and may still be expiring.
    await expect(ben.locator('#avatars .avatar[data-tip^="Ana"]')).toHaveCount(1, {
      timeout: MEMBER_TTL_MS + 4_000,
    });
    const before = await colorOfAna();
    await ana.reload();
    await expect(ana.locator("#joining")).toBeHidden({ timeout: 30_000 });
    await ana.mouse.move(460, 340);
    await expect(ben.locator('#avatars .avatar[data-tip^="Ana"]')).toHaveCount(1);
    expect(await colorOfAna()).toBe(before);
    await ben.locator("#avatars").click();
    await expect(personIn(ben, "Ana")).toHaveCount(1);
    await ben.keyboard.press("Escape");
  });

  await test.step("a new name reaches the other person", async () => {
    await ben.locator("#avatars").click();
    await ben.locator("#you-name").fill("Benji");
    await ben.locator("#you-name").press("Enter");
    await ana.locator("#avatars").click();
    await expect(personIn(ana, "Benji")).toHaveCount(1);
    await expect(cursorOf(ana, "Benji")).toHaveCount(1);
  });

  await test.step("a closed tab says goodbye and drops out at once", async () => {
    const cleo = await join(browser, "Cleo");
    await expect(personIn(ana, "Cleo")).toHaveCount(1);
    await cleo.close({ runBeforeUnload: true });
    await expect(personIn(ana, "Cleo")).toHaveCount(0, { timeout: MEMBER_TTL_MS / 3 });
  });

  await test.step("a tab that crashes drops out once its entry expires", async () => {
    const cdp = await ben.context().newCDPSession(ben);
    // The renderer dies, so the promise never settles and no goodbye is sent.
    void cdp.send("Page.crash").catch(() => {});
    const crashedAt = Date.now();
    await ana.waitForTimeout(1_500);
    await expect(personIn(ana, "Benji")).toHaveCount(1);
    await expect(personIn(ana, "Benji")).toHaveCount(0, { timeout: MEMBER_TTL_MS + 4_000 });
    expect(Date.now() - crashedAt).toBeGreaterThan(MEMBER_TTL_MS / 2);
    await expect(ana.locator("#toast")).toHaveText("Benji left");
  });
});
