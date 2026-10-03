import { randomShapeId } from "@felix-canvas/model";
import { expect, test, type Page } from "@playwright/test";

import { Writer, bodyUpdate, centre, freshSpot, hashes, join, leaveAll, settle } from "./helpers";

test.afterEach(leaveAll);

async function textBox(text: string): Promise<{ id: string; spot: [number, number] }> {
  const writer = await Writer.open();
  const id = randomShapeId();
  const spot = freshSpot();
  await writer.publish(id, "create", {
    type: "text",
    x: spot[0] - 150,
    y: spot[1] - 40,
    w: 300,
    z: "V",
  });
  await writer.publish(id, "text", { y: bodyUpdate([{ block: "p", runs: [[text]] }]) });
  writer.close();
  return { id: id.toString(), spot };
}

/** The text before the other person's caret in `page`'s open editor. */
async function beforeCaret(page: Page): Promise<string | null> {
  const [caret] = await page.evaluate(() => window.felixCanvas.editorCarets());
  return caret?.before ?? null;
}

async function edit(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => window.felixCanvas.edit(id), id);
  await expect(page.locator(".text-editor")).toBeVisible();
  // ProseMirror keeps its own selection for 200 ms after taking focus.
  await page.waitForTimeout(300);
}

test("people editing one text see each other's carets stay on their characters", async ({
  browser,
}) => {
  const { id, spot } = await textBox("The quick fox");
  const [ana, ben, cleo] = await Promise.all(
    ["Ana", "Ben", "Cleo"].map((name) => join(browser, name)),
  );
  for (const page of [ana!, ben!, cleo!]) await centre(page, spot);
  await expect.poll(() => cleo!.evaluate((id) => window.felixCanvas.text(id), id)).not.toBeNull();
  await edit(ana!, id);
  await edit(ben!, id);

  await ben!.keyboard.press("Home");
  for (let i = 0; i < 9; i++) await ben!.keyboard.press("ArrowRight");
  await ana!.keyboard.press("Home");
  await expect.poll(() => beforeCaret(ana!)).toBe("The quick");
  await expect.poll(() => beforeCaret(ben!)).toBe("");

  await ana!.keyboard.type("Very ", { delay: 30 });
  // Ben's caret is still after "quick", though text went in before it.
  await expect.poll(() => beforeCaret(ana!)).toBe("Very The quick");
  await expect.poll(() => beforeCaret(ben!)).toBe("Very ");

  await test.step("someone not editing sees both carets on the canvas", async () => {
    await expect
      .poll(() => cleo!.evaluate(() => window.felixCanvas.carets()))
      .toEqual(
        expect.arrayContaining([
          { name: "Ana", block: 0, offset: 5 },
          { name: "Ben", block: 0, offset: 14 },
        ]),
      );
    await expect(ana!.locator(".text-editor .remote-flag")).toHaveText("Ben");
    await expect(ben!.locator(".text-editor .remote-flag")).toHaveText("Ana");
  });
});

test("rejoining from the snapshot keeps an open editor's caret and unsent typing", async ({
  browser,
}) => {
  const { id, spot } = await textBox("Hello");
  const ana = await join(browser, "Ana");
  const ben = await join(browser, "Ben");
  for (const page of [ana, ben]) await centre(page, spot);
  await expect.poll(() => ana.evaluate((id) => window.felixCanvas.text(id), id)).not.toBeNull();
  await edit(ana, id);
  await ana.keyboard.press("End");
  // Typed and rejoined well inside the 150 ms before typing is sent.
  await ana.keyboard.type("abc");
  await ana.evaluate(() => window.felixCanvas.rejoin());
  await ana.keyboard.type("d");
  await expect(ana.locator(".text-editor .text-body")).toHaveText("Helloabcd");
  await ana.keyboard.press("Escape");
  await settle([ana, ben]);
  await expect
    .poll(() => ben.evaluate((id) => window.felixCanvas.text(id), id))
    .toEqual(["Helloabcd"]);
  expect(new Set(await hashes([ana, ben])).size).toBe(1);
});
