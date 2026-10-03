import { randomShapeId, type TextBlock } from "@felix-canvas/model";
import { expect, test, type Page } from "@playwright/test";

import { Writer, bodyUpdate, centre, freshSpot, join, leaveAll, type BlockSpec } from "./helpers";

test.afterEach(leaveAll);

/** A text box at a fresh spot holding `blocks`. Returns its id and the spot. */
async function textBox(blocks: BlockSpec[]): Promise<{ id: string; spot: [number, number] }> {
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
  await writer.publish(id, "text", { y: bodyUpdate(blocks) });
  writer.close();
  return { id: id.toString(), spot };
}

/** Open the lobby in `theme`, looking at `spot`, with the box's text loaded. */
async function openAt(
  browser: Parameters<typeof join>[0],
  theme: string,
  spot: [number, number],
  id: string,
) {
  const page = await join(browser, "Ana", (page) =>
    page.addInitScript((theme) => localStorage.setItem("felix-canvas.theme", theme), theme),
  );
  await centre(page, spot);
  await expect.poll(() => content(page, id)).not.toBeNull();
  return page;
}

function content(page: Page, id: string): Promise<TextBlock[] | null> {
  return page.evaluate((id) => window.felixCanvas.content(id), id);
}

/** Wait until every run of the body passes `test`. */
async function expectRuns(
  page: Page,
  id: string,
  check: (marks: TextBlock["runs"][number]["marks"]) => boolean,
) {
  await expect
    .poll(async () => {
      const runs = (await content(page, id))?.flatMap((block) => block.runs) ?? [];
      return runs.length > 0 && runs.every((run) => check(run.marks));
    })
    .toBe(true);
}

async function expectBlocks(page: Page, id: string, shape: Partial<TextBlock>[]) {
  await expect
    .poll(async () =>
      (await content(page, id))?.map(({ heading, lists, item }) => ({ heading, lists, item })),
    )
    .toEqual(shape.map((block) => ({ heading: 0, lists: [], item: null, ...block })));
}

for (const theme of ["light", "dark"]) {
  test(`every control in the text bar formats text, in the ${theme} theme`, async ({ browser }) => {
    const { id, spot } = await textBox([{ block: "p", runs: [["Plain words to format"]] }]);
    const page = await openAt(browser, theme, spot, id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.evaluate((id) => window.felixCanvas.edit(id), id);
    await page.keyboard.press("ControlOrMeta+a");
    const bar = page.locator("#text-bar");
    await expect(bar).toBeVisible();

    await test.step("bold, italic and underline toggle and show as pressed", async () => {
      for (const mark of ["b", "i", "u"] as const) {
        await bar.locator(`[data-format=${mark}]`).click();
        await expectRuns(page, id, (marks) => marks[mark] === true);
        await expect(bar.locator(`[data-format=${mark}]`)).toHaveAttribute("aria-pressed", "true");
      }
    });

    await test.step("the block, size and colour menus", async () => {
      await page.locator("#text-block").click();
      await page.getByRole("menuitemradio", { name: "Heading 2" }).click();
      await expectBlocks(page, id, [{ heading: 2 }]);
      await page.locator("#text-size").click();
      await page.getByRole("menuitemradio", { name: "Large" }).click();
      await expectRuns(page, id, (marks) => marks.size === "large");
      await page.locator("#text-color").click();
      await page.getByRole("menuitemradio", { name: "Coral" }).click();
      await expectRuns(page, id, (marks) => marks.color === "coral");
      await page.locator("#text-block").click();
      await page.getByRole("menuitemradio", { name: "Text" }).click();
      await expectBlocks(page, id, [{ heading: 0 }]);
    });

    await test.step("a link, added and removed", async () => {
      await page.locator("#text-link").click();
      await page.locator("#link-address").fill("felix.dev/canvas");
      await page.getByRole("button", { name: "Apply" }).click();
      await expectRuns(page, id, (marks) => marks.a === "https://felix.dev/canvas");
      await page.locator("#text-link").click();
      await expect(page.locator("#link-address")).toHaveValue("https://felix.dev/canvas");
      await page.getByRole("button", { name: "Remove link" }).click();
      await expectRuns(page, id, (marks) => marks.a === undefined);
    });

    await test.step("bulleted and numbered lists, and back to text", async () => {
      await bar.locator("[data-list=ul]").click();
      await expectBlocks(page, id, [{ lists: ["ul"], item: 1 }]);
      await bar.locator("[data-list=ol]").click();
      await expectBlocks(page, id, [{ lists: ["ol"], item: 1 }]);
      await bar.locator("[data-list=ol]").click();
      await expectBlocks(page, id, [{}]);
    });

    await test.step("with the box selected but not open, the bar formats all of it", async () => {
      await page.keyboard.press("Escape");
      await expect(page.locator(".text-editor")).toHaveCount(0);
      await expect(bar).toBeVisible();
      await expect(bar.locator("[data-format=b]")).toHaveAttribute("aria-pressed", "true");
      await bar.locator("[data-format=b]").click();
      await expectRuns(page, id, (marks) => marks.b === undefined);
      await page.locator("#text-color").click();
      await page.getByRole("menuitemradio", { name: "Ink" }).click();
      await expectRuns(page, id, (marks) => marks.color === undefined);
    });
  });
}

test("the text shortcuts and Markdown line starts", async ({ browser }) => {
  const page = await join(browser, "Ana");
  await centre(page, freshSpot());
  await page.keyboard.press("t");
  await page.mouse.click(400, 300);
  const id = (await page.evaluate(() => window.felixCanvas.editing()))!;
  const mod = "ControlOrMeta";

  await page.keyboard.type("# Title");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- first");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("nested");
  await expectBlocks(page, id, [
    { heading: 1 },
    { lists: ["ul"], item: 1 },
    { lists: ["ul", "ul"], item: 1 },
  ]);
  await page.keyboard.press("Shift+Tab");
  await expectBlocks(page, id, [
    { heading: 1 },
    { lists: ["ul"], item: 1 },
    { lists: ["ul"], item: 2 },
  ]);
  // An empty item ends the list; a number and a dot start another.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("1. numbered");
  await expectBlocks(page, id, [
    { heading: 1 },
    { lists: ["ul"], item: 1 },
    { lists: ["ul"], item: 2 },
    { lists: ["ol"], item: 1 },
  ]);

  // Formats on the line just typed, then the list keys on it. ProseMirror
  // reads a caret the browser moved a moment later, sooner than people press
  // the next key but not sooner than a test does.
  const settled = () => page.waitForTimeout(50);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await settled();
  const last = async () => (await content(page, id))?.at(-1) ?? { runs: [], lists: [] };
  for (const mark of ["b", "i", "u"] as const) {
    await page.keyboard.press(`${mod}+${mark}`);
    await expect.poll(async () => (await last()).runs[0]?.marks[mark]).toBe(true);
  }
  await page.keyboard.press(`${mod}+Shift+Period`);
  await expect.poll(async () => (await last()).runs[0]?.marks.size).toBe("large");
  await page.keyboard.press(`${mod}+Shift+Comma`);
  await expect.poll(async () => (await last()).runs[0]?.marks.size).toBeUndefined();
  await page.keyboard.press(`${mod}+Shift+Digit8`);
  await expect.poll(async () => (await last()).lists).toEqual(["ul"]);
  await page.keyboard.press(`${mod}+Shift+Digit7`);
  await expect.poll(async () => (await last()).lists).toEqual(["ol"]);

  // Block keys on the title.
  const title = async () => (await content(page, id))?.[0] ?? { runs: [], heading: -1 };
  await page.keyboard.press(`${mod}+Home`);
  await settled();
  await page.keyboard.press(`${mod}+Alt+Digit2`);
  await expect.poll(async () => (await title()).heading).toBe(2);
  await page.keyboard.press(`${mod}+Alt+Digit3`);
  await expect.poll(async () => (await title()).heading).toBe(3);
  await page.keyboard.press(`${mod}+Alt+Digit0`);
  await expect.poll(async () => (await title()).heading).toBe(0);
  await page.keyboard.press(`${mod}+Alt+Digit1`);
  await expect.poll(async () => (await title()).heading).toBe(1);

  // Undo groups changes made within half a second; keep the link apart.
  await page.waitForTimeout(600);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await settled();
  await page.keyboard.press(`${mod}+k`);
  await expect(page.locator("#link-popover")).toBeVisible();
  await page.keyboard.type("https://felix.dev");
  await page.keyboard.press("Enter");
  await expect(page.locator("#link-popover")).toBeHidden();
  await expect.poll(async () => (await title()).runs[0]?.marks.a).toBe("https://felix.dev");

  // Undo takes back only this person's last change.
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await title()).runs[0]?.marks.a).toBeUndefined();
  expect((await title()).heading).toBe(1);
});

test("pasted HTML keeps only the formats text can have", async ({ browser }) => {
  const { id, spot } = await textBox([{ block: "p", runs: [[""]] }]);
  const page = await openAt(browser, "light", spot, id);
  await page.evaluate((id) => window.felixCanvas.edit(id), id);
  await page.locator(".text-editor .text-body").evaluate((editor) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      '<h4 style="color: cyan">Heading four</h4>' +
        '<p style="color: red; font-size: 40px; font-family: serif">Red <b>bold</b> ' +
        '<span style="font-weight: 700">heavy</span> <font color="lime">lime</font></p>' +
        "<table><tr><td>cell</td></tr></table>" +
        '<p><a href="javascript:alert(1)">bad link</a> <a href="https://felix.dev">good link</a></p>' +
        '<img src="x" onerror="alert(1)"><script>alert(1)</script><ul><li>item</li></ul>',
    );
    data.setData("text/plain", "fallback");
    editor.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect
    .poll(async () =>
      (await content(page, id))!.map((block) => [
        block.heading,
        block.lists,
        block.runs.map((run) => [run.text, run.marks]),
      ]),
    )
    .toEqual([
      [3, [], [["Heading four", {}]]],
      [
        0,
        [],
        [
          ["Red ", {}],
          ["bold", { b: true }],
          [" ", {}],
          ["heavy", { b: true }],
          [" lime", {}],
        ],
      ],
      [0, [], [["cell", {}]]],
      [
        0,
        [],
        [
          ["bad link ", {}],
          ["good link", { a: "https://felix.dev" }],
        ],
      ],
      [0, ["ul"], [["item", {}]]],
    ]);
});

test("links open with Cmd or Ctrl and a click, and never tell the page that opened them", async ({
  browser,
}) => {
  // A plain file, so the new tab stays put while it is checked.
  const href = "http://127.0.0.1:5173/felix-mark.png";
  const { id, spot } = await textBox([{ block: "p", runs: [["A link", { a: { href } }]] }]);
  const page = await openAt(browser, "light", spot, id);
  // The box's first line, a little in from its left edge, with the box's
  // spot at the centre of the 1280 by 720 page.
  await page.mouse.move(640 - 150 + 20, 360 - 40 + 11);
  await expect(page.locator("#link-tip")).toHaveClass(/shown/);
  await expect(page.locator("#link-tip")).toContainText("click to open");
  const opened = page.context().waitForEvent("page");
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("ControlOrMeta");
  const tab = await opened;
  await tab.waitForURL(href);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();
});

test("the interface never names how text is stored or sent", async ({ browser }) => {
  const { id, spot } = await textBox([{ block: "p", runs: [["Some text"]] }]);
  const page = await openAt(browser, "light", spot, id);
  await page.evaluate((id) => window.felixCanvas.edit(id), id);
  const words =
    /\b(yjs|crdt|snapshots?|ops?|log|offsets?|streams?|replay|gateway|hash|prosemirror)\b/i;
  const visibleText = () =>
    page.evaluate(() => {
      const labels = [
        ...document.querySelectorAll("[data-tip], [aria-label], [title], [placeholder]"),
      ]
        .filter((node) => (node as HTMLElement).offsetParent !== null || node === document.body)
        .flatMap((node) =>
          ["data-tip", "aria-label", "title", "placeholder"].map(
            (name) => node.getAttribute(name) ?? "",
          ),
        );
      return [document.body.innerText, ...labels].join("\n");
    });
  for (const open of ["#text-block", "#text-size", "#text-color", "#text-link"]) {
    await page.locator(open).click();
    expect(await visibleText()).not.toMatch(words);
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await expect(page.locator("#shortcuts")).toBeVisible();
  expect(await visibleText()).not.toMatch(words);
});
