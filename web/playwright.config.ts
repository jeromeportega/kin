import { defineConfig, devices } from "@playwright/test"

// Light golden-path E2E. Runs against a local dev server by default; set
// E2E_BASE_URL to smoke-test a deployed URL instead (no server is started then).
// NEVER part of the unit gate (bash scripts/test.sh) — run via `npm run e2e`.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
