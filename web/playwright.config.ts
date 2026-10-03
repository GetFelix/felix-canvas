import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

// The gateway and the page run against the Felix stack `dev/up.sh` started,
// with the token and certificate it wrote.
const root = fileURLToPath(new URL("..", import.meta.url));
const state = `${root}dev/state`;
const token = existsSync(`${state}/gateway.token`)
  ? readFileSync(`${state}/gateway.token`, "utf8").trim()
  : "";

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "cargo run --locked -p felix-canvas-gateway",
      cwd: root,
      url: "http://127.0.0.1:8787/metrics",
      env: { CANVAS_FELIX_TOKEN: token, CANVAS_FELIX_CA_FILE: `${state}/broker-cert.pem` },
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
