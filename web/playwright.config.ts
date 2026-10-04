import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// The canvas's scope file with a short member TTL, so a vanished tab drops out
// within a test's time.
function e2eScopeFile(): string {
  const scope = readFileSync(`${root}deploy/scope.toml`, "utf8");
  if (!scope.includes("ttl_s = 30")) throw new Error("deploy/scope.toml has no ttl_s = 30");
  mkdirSync(state, { recursive: true });
  writeFileSync(`${state}/scope.e2e.toml`, scope.replace("ttl_s = 30", "ttl_s = 6"));
  return `${state}/scope.e2e.toml`;
}

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
          // felix-gateway 0.1.0, from `cargo install felix-gateway --version 0.1.0`.
          command: process.env.CANVAS_GATEWAY_BIN ?? "felix-gateway",
          cwd: root,
          url: "http://127.0.0.1:8787/metrics",
          env: {
            GATEWAY_FELIX_CA_FILE: `${state}/broker-cert.pem`,
            GATEWAY_SCOPE_FILE: e2eScopeFile(),
            GATEWAY_TENANT: "canvas",
            GATEWAY_OIDC_CLIENT_ID: "felix-canvas",
            GATEWAY_FELIX_BROKERS: process.env.CANVAS_FELIX_BROKERS ?? "127.0.0.1:5000",
          },
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
