import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 3210);
/** Local stand-ins for SEEK and LinkedIn (tests/fixtures/browser/sites.mjs). */
export const SITES_PORT = Number(process.env.E2E_SITES_PORT ?? 3299);
// Each run gets an empty database; AI calls are simulated.
// The config is evaluated in every Playwright process; create the folder once and share it via env.
const dataDir = (process.env.HUNTLOOP_E2E_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-e2e-")));
// Use a preinstalled Chromium when one is provided (e.g. in CI images); otherwise Playwright's own.
const chromium = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: "retain-on-failure",
  },
  // The profile flow starts from an empty profile; the other flows build on the profile it creates.
  projects: [
    { name: "profile", testMatch: /profile\.spec\.ts/ },
    { name: "app", testIgnore: [/profile\.spec\.ts/, /bulk-delete\.spec\.ts/, /swipe-delete\.spec\.ts/, /interview\.spec\.ts/], dependencies: ["profile"] },
    // Leaving a job page and coming back while a task runs, and swiping search results away, on iPhone Safari
    // (WebKit), as the owner uses it.
    {
      name: "iphone",
      testMatch: /(task-restore|swipe-delete)\.spec\.ts/,
      dependencies: ["app"],
      use: { ...devices["iPhone 15"], launchOptions: {} },
    },
    // The same swipes with real touch input (Chromium has CDP touch events; Playwright's WebKit doesn't).
    { name: "touch-chromium", testMatch: /swipe-delete\.spec\.ts/, dependencies: ["app"], use: { ...devices["Pixel 7"] } },
    // Deletes every job the other specs created, so it must run last.
    { name: "cleanup", testMatch: /bulk-delete\.spec\.ts/, dependencies: ["app", "iphone", "touch-chromium"] },
    // The CV builder replaces the shared profile, so it runs after everything else.
    { name: "interview", testMatch: /interview\.spec\.ts/, dependencies: ["cleanup"] },
  ],
  webServer: [
    {
      command: `node tests/fixtures/browser/sites.mjs ${SITES_PORT}`,
      url: `http://127.0.0.1:${SITES_PORT}/__reset`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npx next start -H 127.0.0.1 -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        HUNTLOOP_AI: "fake",
        HUNTLOOP_DATA_DIR: dataDir,
        ANTHROPIC_API_KEY: "",
        // Never post CAPTCHA alerts to a real Discord webhook from .env.local ("" counts as unset).
        HUNTLOOP_DISCORD_WEBHOOK: "",
        // Huntloop's own browser runs headless against the local SEEK/LinkedIn stand-ins.
        HUNTLOOP_BROWSER_HEADLESS: "1",
        HUNTLOOP_BROWSER_PACING_MS: "0",
        HUNTLOOP_SEEK_BASE_URL: `http://127.0.0.1:${SITES_PORT}`,
        HUNTLOOP_LINKEDIN_BASE_URL: `http://127.0.0.1:${SITES_PORT}`,
        // The employer watchlist reads a local Greenhouse-style board; no daily checks during tests.
        HUNTLOOP_ATS_API_BASE: `http://127.0.0.1:${SITES_PORT}/ats`,
        HUNTLOOP_SCHEDULER: "off",
        // Research, browsing and CV tailoring for employers named "Slowpoke …", and assessing "Sloth …" jobs, stay
        // running for a while (task-restore.spec.ts).
        HUNTLOOP_FAKE_DELAY: "Slowpoke:companyResearch,browserAgent,planTailoring=8000;Sloth:assess=8000",
        // …and research and CV tailoring for employers named "Doomed …" fail.
        HUNTLOOP_FAKE_FAIL: "Doomed:companyResearch,planTailoring",
        // A second name for the e2e server, so the Host allowlist spec can check a configured host.
        HUNTLOOP_ALLOWED_HOSTS: "huntloop.test:3210",
        // The Settings page asks Claude Code whether it is signed in; keep the real CLI out of tests.
        HUNTLOOP_CLAUDE_PATH: "/nonexistent/claude",
        ...(chromium ? { HUNTLOOP_BROWSER_PATH: chromium } : {}),
      },
    },
  ],
});
