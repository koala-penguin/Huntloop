import "server-only";
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

async function launch(): Promise<BrowserContext> {
  const executablePath = process.env.HUNTLOOP_BROWSER_PATH || undefined;
  const base = {
    headless: headless(),
    viewport: null,
    args: ["--no-first-run", "--no-default-browser-check"],
  };
  try {
    // The user's installed Chrome, unless a browser path is configured.
    return await chromium.launchPersistentContext(browserProfileDir(), executablePath ? { ...base, executablePath } : { ...base, channel: "chrome" });
  } catch (first) {
    if (executablePath) throw new UserFacingError("browser_unavailable", String(first));
    try {
      // Fall back to Playwright's own Chromium if it is installed.
      return await chromium.launchPersistentContext(browserProfileDir(), base);
    } catch {
      throw new UserFacingError("browser_unavailable", String(first));
    }
  }
}

async function context(): Promise<BrowserContext> {
  if (state.context) return state.context;
  state.launching ??= launch()
    .then((ctx) => {
      state.context = ctx;
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

export async function closeBrowser(): Promise<void> {
  const ctx = state.context;
  state.context = undefined;
  if (ctx) await ctx.close().catch(() => undefined);
}
