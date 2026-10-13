import { test as base, expect } from "@playwright/test";

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
