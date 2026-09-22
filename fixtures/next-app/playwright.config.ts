import { defineConfig, devices } from "@playwright/test"

/**
 * Deliberately no `webServer`.
 *
 * Playwright's usual local setup starts `next dev` and tests that. The kit starts the image it
 * just built and passes its URL in E2E_BASE_URL — testing the artifact that would be
 * deployed rather than the sources it was built from, which is the whole point of the stage.
 * With no URL supplied there is no baseURL and every navigation fails, which is the right
 * failure: a suite that quietly fell back to localhost would be testing nothing.
 */
export default defineConfig({
  testDir: "./e2e",
  // A test left focused with .only would silently reduce the suite to itself in CI.
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
