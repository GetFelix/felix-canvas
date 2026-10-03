import { randomShapeId } from "@felix-canvas/model";
import { expect, test, type Page } from "@playwright/test";

import { Writer, bodyUpdate, centre, freshSpot, join, leaveAll, type BlockSpec } from "./helpers";

test.afterEach(leaveAll);

const prose =
  "Felix keeps every change in one log per room, so a canvas is a fold over that log. " +
  "Two people can type in the same paragraph at once, and both of their words survive.";

/** Bodies chosen to cross the places line breaking can go wrong. */
const bodies: { type: "text" | "rect"; w: number; h?: number; blocks: BlockSpec[] }[] = [
  { type: "text", w: 240, blocks: [{ block: "p", runs: [[prose]] }] },
  {
    type: "text",
    w: 200,
    blocks: [
      {
        block: "p",
        runs: [
          ["Mixed "],
          ["bold", { b: {} }],
          [" and "],
          ["italic", { i: {} }],
          [" text, then a "],
          ["large", { size: { step: "large" } }],
          [" word and a "],
          ["huge one", { size: { step: "huge" }, b: {} }],
          [" in the middle of an ordinary sentence."],
        ],
      },
    ],
  },
  {
    type: "text",
    w: 260,
    blocks: [
      { block: "h", level: 1, runs: [["A heading that wraps onto a second line"]] },
      { block: "h", level: 3, runs: [["A smaller heading"]] },
      { block: "p", runs: [["Then a well-known, state-of-the-art paragraph after it."]] },
    ],
  },
  {
    type: "text",
    w: 220,
    blocks: [
      {
        list: "ul",
        items: [
          [{ block: "p", runs: [["A bullet long enough that it wraps under itself"]] }],
          [
            { block: "p", runs: [["Another, with a list inside"]] },
            {
              list: "ol",
              items: [
                [{ block: "p", runs: [["First nested item, also quite long"]] }],
                [{ block: "p", runs: [["Second"]] }],
              ],
            },
          ],
        ],
      },
    ],
  },
  {
    type: "text",
    w: 150,
    blocks: [
      {
        block: "p",
        runs: [["https://example.com/an/address/far/too/long/for/one/line?with=query"]],
      },
      {
        block: "p",
        runs: [["spaces   in    a   row   and a link", { a: { href: "https://felix.dev" } }]],
      },
      { block: "p", runs: [[""]] },
      { block: "p", runs: [["after an empty line"]] },
    ],
  },
  {
    type: "rect",
    w: 220,
    h: 120,
    blocks: [
      { block: "p", runs: [["Text inside a rectangle wraps to the box less its padding."]] },
    ],
  },
];

/** The lines the editor shows, read from where the browser put each character. */
function editorLines(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector(".text-editor .text-body")!;
    const lines: string[] = [];
    for (const block of root.querySelectorAll("p, h1, h2, h3")) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let line = "";
      let left = -Infinity;
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        for (let i = 0; i < node.data.length; i++) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          // A line starts where the next character sits left of the last one.
          if (rect && rect.left + 0.5 < left) {
            lines.push(line);
            line = "";
          }
          if (rect) left = rect.left;
          line += node.data[i];
        }
      }
      lines.push(line);
    }
    return lines;
  });
}

test("the canvas breaks text into the same lines as the editor", async ({ browser }) => {
  const writer = await Writer.open();
  const spot = freshSpot();
  const ids: string[] = [];
  for (const [i, { type, w, h, blocks }] of bodies.entries()) {
    const id = randomShapeId();
    const x = spot[0] - 600 + (i % 3) * 400;
    const y = spot[1] - 300 + Math.floor(i / 3) * 300;
    await writer.publish(id, "create", { type, x, y, w, h: h ?? 0, z: "V" });
    await writer.publish(id, "text", { y: bodyUpdate(blocks) });
    ids.push(id.toString());
  }
  writer.close();

  const page = await join(browser, "Ana");
  await centre(page, spot);
  for (const id of ids) {
    await expect.poll(() => page.evaluate((id) => window.felixCanvas.text(id), id)).not.toBeNull();
    const canvas = (await page.evaluate((id) => window.felixCanvas.text(id), id))!;
    const height = (await page.evaluate((id) => window.felixCanvas.textHeight(id), id))!;
    await page.evaluate((id) => window.felixCanvas.edit(id), id);
    await expect(page.locator(".text-editor")).toBeVisible();
    expect(await editorLines(page), `body ${ids.indexOf(id)}`).toEqual(canvas);
    const shown = await page.locator(".text-editor .text-body").boundingBox();
    expect(Math.abs(shown!.height - height), `height of body ${ids.indexOf(id)}`).toBeLessThan(1);
    await page.keyboard.press("Escape");
  }
});

test("laying out a 2,000-character body takes under 4 ms", async ({ browser }) => {
  const sentence = "The quick brown fox jumps over the lazy dog, then naps in the sun. ";
  const runs: [string, Record<string, Record<string, string>>?][] = [];
  while (runs.reduce((n, [text]) => n + text.length, 0) < 2000) {
    runs.push(
      [sentence],
      ["Bold words", { b: {} }],
      [" and "],
      ["colour", { color: { name: "blue" } }],
      [". "],
    );
  }
  const blocks: BlockSpec[] = [0, 1, 2, 3].map((i) => ({
    block: "p",
    runs: runs.filter((_, j) => j % 4 === i),
  }));
  const writer = await Writer.open();
  const id = randomShapeId();
  const spot = freshSpot();
  await writer.publish(id, "create", { type: "text", x: spot[0], y: spot[1], w: 320, z: "V" });
  await writer.publish(id, "text", { y: bodyUpdate(blocks) });
  writer.close();

  const page = await join(browser, "Ana");
  await expect
    .poll(() => page.evaluate((id) => window.felixCanvas.text(id), id.toString()))
    .not.toBeNull();
  const ms = await page.evaluate((id) => window.felixCanvas.layoutMs(id), id.toString());
  console.log(`laying out a 2,000-character body: median ${ms.toFixed(2)} ms`);
  expect(ms).toBeLessThan(4);
});
