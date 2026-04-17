import { defineConfig } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173"
const apiBaseURL =
  process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:18000/api/v1"
const frontendDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  globalSetup: "./playwright.global-setup.ts",
  globalTeardown: "./playwright.global-teardown.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 4173",
    cwd: frontendDir,
    env: {
      ...process.env,
      VITE_API_BASE_URL: apiBaseURL,
    },
    reuseExistingServer: false,
    url: baseURL,
  },
  reporter: [["list"]],
})
