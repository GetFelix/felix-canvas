import { expect, test, type Page } from "@playwright/test";

import { Typist, Writer, hashes, join, leaveAll, read, settle } from "./helpers";

test.afterEach(leaveAll);

/** Ana's edits per phase: enough samples for a stable median and 90th percentile. */
const EDITS = 100;
/** Records a writer adds in each phase, at 300 a second: four times what 100 kbit/s carries. */
const LOAD = 900;

function quantile(samples: number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/**
 * Busy the room while Ana nudges her rectangle, and return Ana's save times
 * for those nudges. A save time is publish to own delivery, the same path
 * every other viewer's copy of the change takes. Half the load is typing.
 */
async function editUnderLoad(ana: Page): Promise<number[]> {
  const writer = await Writer.open();
  const shape = BigInt(Date.now()) << 64n;
  const box = shape + 1n;
  const typist = new Typist(writer.sid);
  await writer.publish(shape, "create", { type: "rect", x: 3000, y: 3000, w: 40, h: 30, z: "V" });
  await writer.publish(box, "create", { type: "text", x: 3000, y: 3100, w: 200, z: "V" });
  const load = (async () => {
    const acks: Promise<number>[] = [];
    for (let i = 0; i < LOAD; i += 6) {
      for (let j = 0; j < 6; j++) {
        acks.push(
          j % 2
            ? writer.publish(box, "text", { y: typist.type(`${i + j} `) })
            : writer.publish(shape, "patch", { x: 3000 + i + j }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await Promise.all(acks);
  })();
  for (let i = 0; i < EDITS; i++) {
    await ana.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight");
    await ana.waitForTimeout(20);
  }
  await load;
  writer.close();
  await expect.poll(async () => (await read(ana)).pending).toBe(0);
  return ana.evaluate((count) => window.felixCanvas.saveTimes(count), EDITS);
}

test("a throttled viewer falls behind on its own, says so, and converges", async ({ browser }) => {
  test.setTimeout(180_000);
  const ana = await join(browser, "Ana");
  const ben = await join(browser, "Ben");
  const cleo = await join(browser, "Cleo");

  await ana.keyboard.press("r");
  await ana.mouse.move(300, 300);
  await ana.mouse.down();
  await ana.mouse.move(420, 380, { steps: 8 });
  await ana.mouse.up();
  await settle([ana, ben, cleo]);

  const baseline = await editUnderLoad(ana);
  expect(await cleo.evaluate(() => window.felixCanvas.fellBehind())).toBe(0);

  await cleo.locator("#chip").click();
  await cleo.locator("#throttle").click();
  await expect(cleo.locator("#throttle")).toHaveAttribute("aria-checked", "true");
  await cleo.keyboard.press("Escape");

  const throttled = await editUnderLoad(ana);

  await test.step("the throttled viewer reports its own loss and catches up while still slow", async () => {
    await expect(cleo.locator("#behind-title")).toHaveText("Your connection is slow", {
      timeout: 30_000,
    });
    await expect(cleo.locator("#behind-detail")).toHaveText(/^Catching up on [\d,]+ changes$/);
    await expect(cleo.locator("#behind-title")).toHaveText("Back in sync", { timeout: 90_000 });
    await settle([ana, ben, cleo], 30_000);
    const [first, ...rest] = await hashes([ana, ben, cleo]);
    expect(rest).toEqual([first, first]);
    await expect(cleo.locator("#behind-detail")).toHaveText(
      `Up to date · version ${first!.slice(0, 4)}`,
    );
    expect(await ana.evaluate(() => window.felixCanvas.fellBehind())).toBe(0);
    expect(await ben.evaluate(() => window.felixCanvas.fellBehind())).toBe(0);
  });

  await test.step("nobody else's changes slowed down", async () => {
    const report = (samples: number[]) =>
      `p50 ${quantile(samples, 0.5).toFixed(1)} ms, p90 ${quantile(samples, 0.9).toFixed(1)} ms`;
    console.log(`save time without a slow viewer: ${report(baseline)}`);
    console.log(`save time with Cleo throttled:   ${report(throttled)}`);
    // Generous bounds for shared CI machines; a viewer that stalled the
    // others would add hundreds of milliseconds, not a few.
    expect(quantile(throttled, 0.5)).toBeLessThan(50);
    expect(quantile(throttled, 0.5)).toBeLessThan(quantile(baseline, 0.5) * 1.5 + 10);
    expect(quantile(throttled, 0.9)).toBeLessThan(quantile(baseline, 0.9) * 2 + 10);
  });
});
