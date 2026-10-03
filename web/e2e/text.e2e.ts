import { expect, test, type Page } from "@playwright/test";

import { centre, freshSpot, hashes, join, leaveAll, settle } from "./helpers";

test.afterEach(leaveAll);

/** The text in `page`'s open editor. */
function editorText(page: Page): Promise<string> {
  return page.locator(".text-editor .text-body").innerText();
}

function canvasText(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((id) => window.felixCanvas.text(id)?.join("\n"), id);
}

test("two people typing in one text box at once both keep every character", async ({ browser }) => {
  const ana = await join(browser, "Ana");
  const ben = await join(browser, "Ben");
  const spot = freshSpot();
  await Promise.all([ana, ben].map((page) => centre(page, spot)));

  const id = await test.step("one person starts a text box with the text tool", async () => {
    await ana.keyboard.press("t");
    await ana.mouse.click(500, 400);
    await expect(ana.locator(".text-editor .placeholder")).toBeVisible();
    await ana.keyboard.type("The cat sat.");
    const id = (await ana.evaluate(() => window.felixCanvas.editing()))!;
    await expect.poll(() => canvasText(ben, id)).toBe("The cat sat.");
    return id;
  });

  await test.step("the other opens it and both type at once", async () => {
    await ben.mouse.dblclick(510, 400);
    await expect(ben.locator(".text-editor")).toBeVisible();
    // ProseMirror puts back its own selection when the page's moves within
    // 200 ms of the editor taking focus, as a click's would.
    await ben.waitForTimeout(300);
    await ben.keyboard.press("Home");
    await ana.keyboard.press("End");
    await Promise.all([
      ana.keyboard.type(" Ana was here.", { delay: 40 }),
      ben.keyboard.type("Ben says: ", { delay: 40 }),
    ]);
    const merged = "Ben says: The cat sat. Ana was here.";
    await expect.poll(() => editorText(ana)).toBe(merged);
    await expect.poll(() => editorText(ben)).toBe(merged);
  });

  await test.step("the canvas shows the same text once both stop", async () => {
    await Promise.all([ana, ben].map((page) => page.keyboard.press("Escape")));
    await expect(ana.locator(".text-editor")).toHaveCount(0);
    await settle([ana, ben]);
    expect(await canvasText(ana, id)).toBe(await canvasText(ben, id));
    expect(await canvasText(ana, id)).toContain("Ana was here.");
    expect(new Set(await hashes([ana, ben])).size).toBe(1);
  });

  await test.step("a browser that joins later shows the same text", async () => {
    const cleo = await join(browser, "Cleo");
    await settle([ana, cleo]);
    expect(await canvasText(cleo, id)).toBe(await canvasText(ana, id));
  });
});

test("your own typing shows in the editor within a frame", async ({ browser }) => {
  const ana = await join(browser, "Ana");
  await centre(ana, freshSpot());
  await ana.keyboard.press("t");
  await ana.mouse.click(400, 300);
  await ana.keyboard.type("Typing shows up on the very next frame, every time.", { delay: 30 });
  const times = await ana.evaluate(() => window.felixCanvas.textEchoTimes(100));
  expect(times.length).toBeGreaterThan(40);
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  console.log(`keystroke to frame: median ${median.toFixed(1)} ms over ${times.length} keys`);
  expect(median).toBeLessThan(1000 / 60);
});

test("an empty new text box goes away when you stop editing", async ({ browser }) => {
  const ana = await join(browser, "Ana");
  await centre(ana, freshSpot());
  const before = await ana.evaluate(() => window.felixCanvas.shapes());
  await ana.keyboard.press("t");
  await ana.mouse.click(400, 300);
  await expect(ana.locator(".text-editor")).toBeVisible();
  await ana.keyboard.press("Escape");
  await expect.poll(() => ana.evaluate(() => window.felixCanvas.shapes())).toBe(before);
});
