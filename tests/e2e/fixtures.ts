import { test as base, expect, type Page } from "@playwright/test";

/** Every E2E test fails on uncaught browser errors (hydration mismatches included). */
export const test = base.extend<{ failOnPageErrors: void }>({
  failOnPageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await use();
      expect(errors, "uncaught errors in the browser").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Holds back the page's scripts, as on a slow phone: the server-rendered page shows and can be typed
 * into, but React hasn't hydrated it yet. Call the returned function to let the scripts load.
 */
export async function holdScripts(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/_next\/static\/chunks\/.+\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}
