import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 8_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never", outputFolder: "output/playwright/report" }]] : "line",
  use: {
    baseURL: process.env.GOOSEY_BROWSER_BASE_URL ?? "http://127.0.0.1:8081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  outputDir: "output/playwright/test-results",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.GOOSEY_BROWSER_BASE_URL ? undefined : {
    command: "npm run test:browser:server",
    url: "http://127.0.0.1:8081/api/health",
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      DATABASE_URL: "file:./browser-e2e.db",
      DATABASE_PROVIDER: "sqlite",
      APP_URL: "http://127.0.0.1:8081",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:8081",
      EMAIL_VERIFICATION_URL: "http://127.0.0.1:8081/verify-email",
      RATE_LIMIT_KEY_SECRET: "goosey-browser-e2e-rate-limit-secret-32-bytes",
      GOOSEY_TOKEN_SECRET: "goosey-browser-e2e-token-secret-32-bytes",
    },
  },
});
