import { expect, test } from "./fixtures";

test("the Huntloop name links home on desktop and on a phone", async ({ page }) => {
  await page.goto("/jobs");
  await page.getByRole("link", { name: "Huntloop home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // On a phone the sidebar is hidden and the name sits in the mobile header.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/jobs");
  await page.getByRole("link", { name: "Huntloop home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});
