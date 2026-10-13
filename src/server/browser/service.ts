import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { dataDir } from "../config/env";
import { UserFacingError } from "../errors";

/**
 * Huntloop's own browser window on the user's computer, used for sites without an API (SEEK,
 * LinkedIn). It is visible (headed) so the user sees everything it does and can step in, uses a
 * separate profile (data/browser-profile), and only one task drives it at a time.
 */

interface BrowserState {
  context?: BrowserContext;
  /** Launched with a (localhost-only) DevTools port, for the browsing agent. */
  debugging?: boolean;
  launching?: Promise<BrowserContext>;
  idleTimer?: NodeJS.Timeout;
  queue: Promise<unknown>;
}

const state = ((globalThis as unknown as { huntloopBrowser?: BrowserState }).huntloopBrowser ??= { queue: Promise.resolve() });
const IDLE_CLOSE_MS = 5 * 60_000;

export function browserProfileDir(): string {
  return path.join(dataDir(), "browser-profile");
}

/** Headless only when asked (tests); the user should see the window. */
function headless(): boolean {
  return process.env.HUNTLOOP_BROWSER_HEADLESS === "1";
}

/** Which browser to start: the configured path, else the installed Chrome, else Playwright's own Chromium. */
export function browserCandidates(): Array<{ executablePath?: string; channel?: string }> {
  const executablePath = process.env.HUNTLOOP_BROWSER_PATH || undefined;
  return executablePath ? [{ executablePath }] : [{ channel: "chrome" }, {}];
}

async function launch(debugging: boolean): Promise<BrowserContext> {
  const base = {
    headless: headless(),
    viewport: null,
    // The DevTools port (random, 127.0.0.1 only) is opened only when the browsing agent needs it.
    args: ["--no-first-run", "--no-default-browser-check", ...(debugging ? ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"] : [])],
  };
  let first: unknown;
  for (const candidate of browserCandidates()) {
    try {
      return await chromium.launchPersistentContext(browserProfileDir(), { ...base, ...candidate });
    } catch (error) {
      first ??= error;
    }
  }
  throw new UserFacingError("browser_unavailable", String(first));
}

async function context(debugging = false): Promise<BrowserContext> {
  if (state.context && debugging && !state.debugging) await closeBrowser();
  if (state.context) return state.context;
  state.launching ??= launch(debugging)
    .then((ctx) => {
      state.context = ctx;
      state.debugging = debugging;
      ctx.on("close", () => {
        state.context = undefined;
      });
      return ctx;
    })
    .finally(() => {
      state.launching = undefined;
    });
  return state.launching;
}

function scheduleIdleClose(): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => void closeBrowser(), IDLE_CLOSE_MS);
  state.idleTimer.unref?.();
}

/**
 * Runs `fn` with a fresh tab. Calls are queued, so one task drives the browser at a time.
 * The window stays open briefly afterwards for the next task.
 */
export function withBrowserPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const run = async () => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    const ctx = await context();
    const page = await ctx.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
      scheduleIdleClose();
    }
  };
  const result = state.queue.then(run, run);
  state.queue = result.catch(() => undefined);
  return result;
}

/**
 * Runs `fn` with the whole browser (all tabs), launched with its DevTools port, for the browsing
 * agent. Queued like withBrowserPage, so nothing else drives the browser meanwhile.
 */
export function withDebuggableBrowser<T>(fn: (ctx: BrowserContext, devtoolsUrl: string) => Promise<T>): Promise<T> {
  const run = async () => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    const ctx = await context(true);
    try {
      return await fn(ctx, await devtoolsUrl());
    } finally {
      scheduleIdleClose();
    }
  };
  const result = state.queue.then(run, run);
  state.queue = result.catch(() => undefined);
  return result;
}

/** Chrome writes the chosen port to DevToolsActivePort in its profile directory. */
async function devtoolsUrl(): Promise<string> {
  const file = path.join(browserProfileDir(), "DevToolsActivePort");
  for (let i = 0; i < 50; i++) {
    const port = (await fs.readFile(file, "utf8").catch(() => "")).split("\n")[0]?.trim();
    if (port && /^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new UserFacingError("browser_unavailable", "The browser's DevTools port didn't open");
}

export async function closeBrowser(): Promise<void> {
  const ctx = state.context;
  state.context = undefined;
  if (ctx) await ctx.close().catch(() => undefined);
}
