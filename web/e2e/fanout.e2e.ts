import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { join, leaveAll, read } from "./helpers";

// A measurement rather than a check, so it runs only when asked:
// CANVAS_FANOUT_VIEWERS=500 npm run test:e2e -w @felix-canvas/web -- fanout
// docs/development.md has the full recipe.
const VIEWERS = Number(process.env.CANVAS_FANOUT_VIEWERS ?? 0);
test.skip(!VIEWERS, "set CANVAS_FANOUT_VIEWERS to measure fanout");
test.afterEach(leaveAll);

/** Edits per phase, one every 50 ms: the page publishes at most 20 ops a second. */
const EDITS = Number(process.env.CANVAS_FANOUT_EDITS ?? 300);
/** Each round measures 1 viewer, then the full count, so drift over the run hits both alike. */
const ROUNDS = 3;

const root = fileURLToPath(new URL("../../", import.meta.url));

interface Summary {
  viewers: number;
  connections: number;
  received_min: number | null;
  received_max: number | null;
  dropped: number;
  ended: number;
}

/** Start `count` viewers on the lobby's op stream; `stop` ends them and returns what they saw. */
async function startViewers(count: number): Promise<{ stop: () => Promise<Summary> }> {
  // felix-gateway's `viewers` example; docs/development.md says how to build it.
  const bin = process.env.CANVAS_VIEWERS_BIN;
  if (!bin) throw new Error("set CANVAS_VIEWERS_BIN to felix-gateway's viewers example");
  const child = spawn(bin, [String(count), `${root}dev/state/snapshotter.token`, "ops", "lobby"], {
    env: {
      ...process.env,
      GATEWAY_FELIX_CA_FILE: `${root}dev/state/broker-cert.pem`,
      GATEWAY_SCOPE_FILE: `${root}deploy/scope.toml`,
      GATEWAY_TENANT: "canvas",
      GATEWAY_OIDC_CLIENT_ID: "felix-canvas",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ready = await lines.next();
  if (ready.value !== "ready") throw new Error(`viewers did not start: ${ready.value}`);
  return {
    stop: async () => {
      child.stdin.end();
      return JSON.parse(String((await lines.next()).value)) as Summary;
    },
  };
}

/** Nudge the selected rectangle `EDITS` times and return each nudge's ack and save time. */
async function edit(page: Page): Promise<{ acks: number[]; saves: number[] }> {
  for (let i = 0; i < EDITS; i++) {
    await page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(50);
  }
  await expect.poll(async () => (await read(page)).pending).toBe(0);
  return page.evaluate(
    (count) => ({
      acks: window.felixCanvas.ackTimes(count),
      saves: window.felixCanvas.saveTimes(count),
    }),
    EDITS,
  );
}

function quantile(samples: number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

test(`publish latency holds with ${VIEWERS} viewers`, async ({ browser }) => {
  test.setTimeout(600_000);
  const ana = await join(browser, "Ana");
  await ana.keyboard.press("r");
  await ana.mouse.move(300, 300);
  await ana.mouse.down();
  await ana.mouse.move(420, 380, { steps: 8 });
  await ana.mouse.up();
  await expect.poll(async () => (await read(ana)).pending).toBe(0);

  const samples = new Map<number, { acks: number[]; saves: number[] }>([
    [1, { acks: [], saves: [] }],
    [VIEWERS, { acks: [], saves: [] }],
  ]);
  for (let round = 0; round < ROUNDS; round++) {
    for (const count of [1, VIEWERS]) {
      // Ana's own tab is one of the viewers.
      const viewers = await startViewers(count - 1);
      const { acks, saves } = await edit(ana);
      const seen = await viewers.stop();
      console.log(
        `round ${round + 1}, ${count} viewers: ack p50 ${quantile(acks, 0.5).toFixed(1)} ms, ` +
          `save p50 ${quantile(saves, 0.5).toFixed(1)} ms; the other viewers held ` +
          `${seen.connections} connections, got ${seen.received_min ?? "-"} to ` +
          `${seen.received_max ?? "-"} changes each, ${seen.dropped} dropped, ${seen.ended} ended early`,
      );
      if (count > 1) expect(seen.received_min).toBeGreaterThanOrEqual(EDITS);
      expect(seen.dropped).toBe(0);
      expect(seen.ended).toBe(0);
      samples.get(count)!.acks.push(...acks);
      samples.get(count)!.saves.push(...saves);
    }
  }

  const report = (label: string, values: number[]) =>
    `${label} p50 ${quantile(values, 0.5).toFixed(1)} ms, p90 ${quantile(values, 0.9).toFixed(1)} ms`;
  const one = samples.get(1)!;
  const many = samples.get(VIEWERS)!;
  console.log(`1 viewer:        ${report("ack", one.acks)}; ${report("save", one.saves)}`);
  console.log(`${VIEWERS} viewers: ${report("ack", many.acks)}; ${report("save", many.saves)}`);
  const ratio = quantile(many.acks, 0.5) / quantile(one.acks, 0.5);
  console.log(`ack p50 ratio ${ratio.toFixed(3)}`);
  expect(ratio).toBeLessThanOrEqual(1.15);
});
