import { decodeOp } from "@felix-canvas/model";
import { expect, test, type Page } from "@playwright/test";

import {
  Writer,
  busyRoom,
  centre,
  freshSpot,
  join,
  leaveAll,
  read,
  readLog,
  settle,
} from "./helpers";

// Measures the design's performance targets and prints them, so it runs only
// when asked: CANVAS_MEASURE=1 npm run test:e2e -w @felix-canvas/web -- targets
// docs/development.md has the full recipe.
test.skip(!process.env.CANVAS_MEASURE, "set CANVAS_MEASURE to measure the targets");
test.afterEach(leaveAll);

const SNAPSHOTTER = "http://127.0.0.1:8788/";
const SAMPLES = 300;

function quantile(samples: number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const ms = (value: number) => `${value.toFixed(1)} ms`;

function row(path: string, target: string, measured: string): void {
  console.log(`| ${path} | ${target} | ${measured} |`);
}

async function times(page: Page, kind: "echo" | "peerEdit" | "cursor"): Promise<number[]> {
  return page.evaluate(
    ([kind, count]) =>
      kind === "echo"
        ? window.felixCanvas.echoTimes(count)
        : kind === "peerEdit"
          ? window.felixCanvas.peerEditTimes(count)
          : window.felixCanvas.cursorTimes(count),
    [kind, SAMPLES] as const,
  );
}

async function snapshotterPosition(): Promise<{ applied: number; saved: number }> {
  const rooms = (await (await fetch(SNAPSHOTTER)).json()) as {
    lobby: { applied: number; saved: number };
  };
  return rooms.lobby;
}

test("the performance targets", async ({ browser }) => {
  test.setTimeout(600_000);
  const ana = await join(browser, "Ana");
  const ben = await join(browser, "Ben");
  console.log("| Path | Target | Measured |\n|---|---|---|");

  await test.step("local echo, and an edit reaching another browser", async () => {
    await ana.keyboard.press("r");
    await ana.mouse.move(300, 300);
    await ana.mouse.down();
    await ana.mouse.move(420, 380, { steps: 8 });
    await ana.mouse.up();
    await settle([ana, ben]);
    for (let i = 0; i < SAMPLES; i++) {
      await ana.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight");
      await ana.waitForTimeout(30);
    }
    await settle([ana, ben]);
    const echo = await times(ana, "echo");
    const seen = await times(ben, "peerEdit");
    expect(seen.length).toBe(SAMPLES);
    row("Local echo", "< 16 ms", `p50 ${ms(quantile(echo, 0.5))}, p99 ${ms(quantile(echo, 0.99))}`);
    row(
      "Edit visible to another client",
      "< 50 ms p50, < 150 ms p99",
      `p50 ${ms(quantile(seen, 0.5))}, p99 ${ms(quantile(seen, 0.99))}`,
    );
    expect(quantile(echo, 0.5)).toBeLessThan(16);
    expect(quantile(seen, 0.5)).toBeLessThan(50);
    expect(quantile(seen, 0.99)).toBeLessThan(150);
  });

  await test.step("typing, seen by its author and by another browser", async () => {
    const spot = freshSpot();
    await Promise.all([ana, ben].map((page) => centre(page, spot)));
    await ana.keyboard.press("t");
    await ana.mouse.click(400, 300);
    const id = (await ana.evaluate(() => window.felixCanvas.editing()))!;
    // Ben watches the text on his canvas.
    await expect.poll(() => ben.evaluate((id) => window.felixCanvas.text(id), id)).not.toBeNull();
    const from = (await read(ana)).applied;
    const started = Date.now();
    // Ten keys a second for 30 seconds.
    const sentence = "the quick brown fox jumps over the lazy dog ";
    for (let i = 0; i < 300; i++) {
      await ana.keyboard.type(sentence[i % sentence.length]!);
      await ana.waitForTimeout(Math.max(0, started + (i + 1) * 100 - Date.now()));
    }
    const seconds = (Date.now() - started) / 1000;
    await ana.keyboard.press("Escape");
    await settle([ana, ben]);
    const own = await ana.evaluate(() => window.felixCanvas.textEchoTimes(300));
    const seen = await ben.evaluate(() => window.felixCanvas.peerTextTimes(300));
    const sid = await ana.evaluate(() => window.felixCanvas.sid());
    const log = await readLog((await read(ana)).applied);
    const sent = log
      .slice(from)
      .map(([, payload]) => decodeOp(payload))
      .filter((op) => op.kind === "text" && op.sid === BigInt(sid)).length;
    row(
      "Keystroke to own character in the editor",
      "< 16 ms",
      `p50 ${ms(quantile(own, 0.5))}, p99 ${ms(quantile(own, 0.99))}`,
    );
    row(
      "Typed text visible to another client",
      "< 250 ms p50, < 400 ms p99",
      `p50 ${ms(quantile(seen, 0.5))}, p99 ${ms(quantile(seen, 0.99))}, from the first keystroke each change carries`,
    );
    row(
      "Text ops per typing person",
      "≤ 7 a second",
      `${(sent / seconds).toFixed(1)} a second at 10 keys a second`,
    );
    expect(quantile(own, 0.5)).toBeLessThan(16);
    expect(quantile(seen, 0.5)).toBeLessThan(250);
    expect(quantile(seen, 0.99)).toBeLessThan(400);
    expect(sent / seconds).toBeLessThanOrEqual(7);
  });

  await test.step("a cursor reaching another browser", async () => {
    await ana.keyboard.press("v");
    for (let i = 0; i < SAMPLES; i++) {
      await ana.mouse.move(200 + (i % 100) * 6, 500 + (i % 7) * 10);
      await ana.waitForTimeout(20);
    }
    const cursor = await times(ana, "cursor");
    row("Cursor visible to another client", "< 40 ms p50", `p50 ${ms(quantile(cursor, 0.5))}`);
    expect(quantile(cursor, 0.5)).toBeLessThan(40);
  });

  await test.step("snapshot lag under steady editing", async () => {
    // 300 changes a second for 30 seconds, sampling how far the stored
    // snapshot is behind the newest change.
    const writer = await Writer.open();
    const shape = BigInt(Date.now()) << 64n;
    let tail = await writer.publish(shape, "create", {
      type: "rect",
      x: 4000,
      y: 4000,
      w: 40,
      h: 30,
      z: "V",
    });
    const lags: number[] = [];
    const started = Date.now();
    for (let i = 0; Date.now() - started < 30_000; i++) {
      const acks = Array.from({ length: 6 }, (_, j) =>
        writer.publish(shape, "patch", { x: 4000 + ((i * 6 + j) % 500) }),
      );
      tail = Math.max(tail, ...(await Promise.all(acks)));
      if (i % 10 === 0) lags.push(tail - (await snapshotterPosition()).saved);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    writer.close();
    row(
      "Snapshot lag",
      "< 1,000 changes behind",
      `p50 ${quantile(lags, 0.5)}, max ${Math.max(...lags)} changes, at 300 changes/s`,
    );
    expect(Math.max(...lags)).toBeLessThan(1000);
  });

  for (const text of [false, true]) {
    await test.step(`a cold browser joining a 10,000-change room${text ? ", half of it typing" : ""}`, async () => {
      const tail = await busyRoom(10_000, 10, "lobby", { text });
      await expect
        .poll(async () => (await snapshotterPosition()).saved, { timeout: 60_000 })
        .toBeGreaterThan(tail - 1000);
      const cleo = await join(browser);
      const { firstFrameMs } = await read(cleo);
      row(
        text
          ? "Join a 10,000-change room, half of it typing into 50 boxes"
          : "Join a 10,000-change room",
        "< 500 ms to first correct frame",
        ms(firstFrameMs!),
      );
      expect(firstFrameMs!).toBeLessThan(500);
    });
  }
});
