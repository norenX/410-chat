import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "NODE_ENV=production HOST=127.0.0.1 PORT=4173 METRICS_FILE=/tmp/410-playwright-metrics.json DISCONNECT_GRACE_MS=5000 HARD_TTL_MS=120000 HEARTBEAT_EVERY_MS=150 HEARTBEAT_STALE_MS=700 MAX_CREATES_PER_WINDOW=30 MAX_RELAYS_PER_WINDOW=1000 GROUP_ROOMS_ENABLED=true GROUP_HARD_TTL_MS=120000 GROUP_REKEY_TIMEOUT_MS=5000 MAX_GROUP_RELAYS_PER_WINDOW=1000 node dist-server/server/index.js",
    url: "http://127.0.0.1:4173/healthz",
    reuseExistingServer: false,
    timeout: 30_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } }
  ]
});
