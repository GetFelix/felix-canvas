import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

// The gateway, the snapshotter and the page run against the Felix stack
// `dev/up.sh` started, with the snapshotter's token and the certificate it wrote.
// With CANVAS_E2E_URL the tests instead use an install already serving there.
const installed = process.env.CANVAS_E2E_URL;
const root = fileURLToPath(new URL("..", import.meta.url));
const state = `${root}dev/state`;
const token = (name: string) =>
  existsSync(`${state}/${name}.token`) ? readFileSync(`${state}/${name}.token`, "utf8").trim() : "";

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  // The tests share the dev stack's rooms.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: installed ?? "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: installed
    ? []
    : [
        {
          command: "cargo run --locked -p felix-canvas-gateway",
          cwd: root,
          url: "http://127.0.0.1:8787/metrics",
          env: {
            CANVAS_FELIX_CA_FILE: `${state}/broker-cert.pem`,
            // Short, so a vanished tab drops out within the test's time.
            CANVAS_MEMBER_TTL_SECONDS: "6",
          },
          timeout: 300_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          command:
            "npm run build -w @felix-canvas/snapshotter && npm start -w @felix-canvas/snapshotter",
          cwd: root,
          url: "http://127.0.0.1:8788/",
          env: {
            CANVAS_FELIX_TOKEN: token("snapshotter"),
            CANVAS_FELIX_CA_FILE: `${state}/broker-cert.pem`,
          },
          reuseExistingServer: !process.env.CI,
        },
        {
          command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: !process.env.CI,
        },
      ],
});
